package dev.pi.agent.manage

import com.intellij.openapi.diagnostic.Logger
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

    fun run(args: List<String>, timeoutSeconds: Long = 60): CliResult {
        val pi = PiLocator.locate()?.path
            ?: return CliResult(-1, "", "pi executable not found")

        val command = PiLocator.spawnCommand(pi, args)
        val pb = ProcessBuilder(command)
        pb.redirectErrorStream(false)
        val env = pb.environment()
        val pathDirs = buildList {
            PiLocator.nodeBinDirFor(pi)?.let { add(it) }
            addAll(PiLocator.loginShellPath())
            add(env["PATH"] ?: "")
        }.filter { it.isNotBlank() }.distinct()
        env["PATH"] = pathDirs.joinToString(":")
        // Management commands must not try to talk to a TUI.
        env["PI_NO_COLOR"] = "1"

        LOG.info("pi cli: ${args.joinToString(" ")}")
        return try {
            val proc = pb.start()
            val finished = proc.waitFor(timeoutSeconds, TimeUnit.SECONDS)
            if (!finished) {
                proc.destroyForcibly()
                CliResult(-1, "", "timed out after ${timeoutSeconds}s: ${command.joinToString(" ")}")
            } else {
                CliResult(
                    exitCode = proc.exitValue(),
                    stdout = proc.inputStream.bufferedReader().readText(),
                    stderr = proc.errorStream.bufferedReader().readText(),
                )
            }
        } catch (e: Exception) {
            CliResult(-1, "", "failed to run pi: ${e.message}")
        }
    }

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

    /** User-level pi config files. */
    fun agentDir(): File = File(System.getProperty("user.home"), ".pi/agent")
}
