package dev.pi.agent.manage

import com.intellij.openapi.diagnostic.Logger
import dev.pi.agent.process.OsProcess
import dev.pi.agent.process.PiLocator
import java.io.File
import java.util.concurrent.TimeUnit

/** Result of a `pi <subcommand>` invocation. */
data class CliResult(
    val exitCode: Int,
    val stdout: String,
    val stderr: String,
) {
    val success: Boolean get() = exitCode == 0
}

/**
 * Runs pi CLI subcommands safely: argv array only (never a shell), PATH
 * augmented from the login shell, bounded runtime.
 */
object PiCliRunner {

    private val LOG = Logger.getInstance(PiCliRunner::class.java)

    /**
     * Runs `pi` with [args]. When [stdinText] is non-null it is piped to the
     * child's stdin (and stdin is closed right after): prompts bigger than
     * the OS command-line limit (e.g. large diffs) must travel this way.
     *
     * [workingDir] matters for every command that reads or writes project-local
     * files (`pi mcp list`, `pi mcp add --local`): without it the child inherits
     * the IDE process cwd, so a multi-project window would report — or worse,
     * edit — some other project's `.pi/` directory (or nothing at all).
     */
    fun run(
        args: List<String>,
        timeoutSeconds: Long = 60,
        stdinText: String? = null,
        workingDir: File? = null,
    ): CliResult {
        val pi = PiLocator.locate()?.path
            ?: return CliResult(-1, "", "pi executable not found")

        val command = PiLocator.spawnCommand(pi, args)
        val pb = ProcessBuilder(command)
        workingDir?.takeIf { it.isDirectory }?.let { pb.directory(it) }
        pb.redirectErrorStream(false)
        OsProcess.augmentPathEnv(pb, buildList {
            PiLocator.nodeBinDirFor(pi)?.let { add(it) }
            addAll(PiLocator.loginShellPath())
        })
        // Management commands must not try to talk to a TUI.
        pb.environment()["PI_NO_COLOR"] = "1"

        LOG.info("pi cli: ${args.joinToString(" ")}${if (stdinText != null) " (stdin: ${stdinText.length} chars)" else ""}")
        return runProcess(pb, timeoutSeconds, stdinText)
    }

    /**
     * Runs [pb] with both streams drained concurrently. Draining must happen
     * *while* the process runs: waiting first would deadlock whenever output
     * exceeds the OS pipe buffer (~64KB) because the child blocks on write and
     * can never exit.
     */
    internal fun runProcess(pb: ProcessBuilder, timeoutSeconds: Long, stdinText: String? = null): CliResult {
        return try {
            val proc = pb.start()
            val stdout = StringBuilder()
            val stderr = StringBuilder()
            val drainOut = drainThread(proc.inputStream, stdout)
            val drainErr = drainThread(proc.errorStream, stderr)
            // Write stdin from its own thread: a prompt larger than the pipe
            // buffer blocks the writer until the child consumes it, and the
            // child may exit early (bad flag, auth error) — the closer below
            // then unblocks us instead of hanging forever.
            val feedIn = stdinText?.let { writerThread(proc.outputStream, it) }
            val finished = proc.waitFor(timeoutSeconds, TimeUnit.SECONDS)
            if (!finished) {
                // Kill the whole tree: orphaned grandchildren (sleep/ping under
                // a shell) keep the pipes open on Linux, where closing our end
                // does not wake a thread blocked in read().
                runCatching { proc.toHandle().descendants().forEach { it.destroyForcibly() } }
                proc.destroyForcibly()
                // Belt and suspenders for platforms where descendants may miss.
                runCatching { proc.outputStream.close() }
                runCatching { proc.inputStream.close() }
                runCatching { proc.errorStream.close() }
                feedIn?.join(1000)
                // Give the readers a moment to observe the closed pipes.
                drainOut.join(1000)
                drainErr.join(1000)
                CliResult(
                    -1,
                    stdout.toString(),
                    "timed out after ${timeoutSeconds}s: ${pb.command().joinToString(" ")}",
                )
            } else {
                // Exited: both streams reach EOF quickly. Unbounded join is safe.
                feedIn?.join(10_000)
                drainOut.join(10_000)
                drainErr.join(10_000)
                CliResult(proc.exitValue(), stdout.toString(), stderr.toString())
            }
        } catch (e: Exception) {
            CliResult(-1, "", "failed to run pi: ${e.message}")
        }
    }

    /**
     * Runs [pb] to completion with **no time limit**, handing the live process to
     * [onStart] so the caller can stop it.
     *
     * Exists for `npm install`: a cold install over a slow mirror legitimately
     * takes tens of minutes (measured: ~14 min), so any fixed ceiling is wrong in
     * both directions — short kills a working download, long looks hung and
     * cannot be told apart from a dead one. The user decides when to give up, and
     * [onStart] is what makes "stop" reachable while we wait.
     */
    internal fun runProcessUntilExit(pb: ProcessBuilder, onStart: (Process) -> Unit = {}): CliResult {
        return try {
            val proc = pb.start()
            onStart(proc)
            val stdout = StringBuilder()
            val stderr = StringBuilder()
            val drainOut = drainThread(proc.inputStream, stdout)
            val drainErr = drainThread(proc.errorStream, stderr)
            val exit = proc.waitFor()
            drainOut.join(10_000)
            drainErr.join(10_000)
            CliResult(exit, stdout.toString(), stderr.toString())
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            CliResult(-1, "", "interrupted")
        } catch (e: Exception) {
            CliResult(-1, "", "failed to run pi: ${e.message}")
        }
    }

    private fun drainThread(stream: java.io.InputStream, into: StringBuilder): Thread =
        Thread({
            try {
                stream.bufferedReader().forEachLine { line ->
                    synchronized(into) { into.appendLine(line) }
                }
            } catch (_: java.io.IOException) {
                // stream closed with the process
            }
        }, "pi-cli-drain").apply { isDaemon = true; start() }

    /** Writes the whole [text] to [stream], then closes it. */
    private fun writerThread(stream: java.io.OutputStream, text: String): Thread =
        Thread({
            try {
                stream.use { it.write(text.toByteArray(Charsets.UTF_8)); it.flush() }
            } catch (_: java.io.IOException) {
                // child exited before reading everything
            }
        }, "pi-cli-feedin").apply { isDaemon = true; start() }

    /** Parses the first JSON value found in stdout (CLI wrappers may add noise). */
    fun parseJsonOrNull(result: CliResult): kotlinx.serialization.json.JsonElement? {
        if (!result.success && result.stdout.isBlank()) return null
        val text = result.stdout.trim()
        return try {
            kotlinx.serialization.json.Json.parseToJsonElement(text)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * User-level pi config files. Honors pi's `PI_CODING_AGENT_DIR` override
     * (matching PiSessionIndex's handling of `PI_CODING_AGENT_SESSION_DIR`).
     */
    fun agentDir(): File =
        System.getenv("PI_CODING_AGENT_DIR")?.takeIf { it.isNotBlank() }
            ?.let { File(it) }
            ?: File(System.getProperty("user.home"), ".pi/agent")
}
