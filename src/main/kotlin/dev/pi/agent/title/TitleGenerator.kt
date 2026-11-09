package dev.pi.agent.title

import com.intellij.openapi.diagnostic.Logger
import dev.pi.agent.process.OsProcess
import dev.pi.agent.process.PiLocator
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * B-stage session titling, layered on top of the web store's heuristic
 * (A: first user message, no model call). After the first assistant reply the
 * store asks this one-shot `pi -p` process to turn the exchange into a short
 * title; A's result stays on disk until B succeeds, so a failed, timed-out or
 * killed run simply leaves the better-than-nothing title in place.
 *
 * Ephemeral by design: `--no-session` keeps the call out of the session list,
 * `--no-tools` and `--no-extensions`/`--no-mcp` keep pi from starting anything
 * a title call never needs, and the system prompt replaces pi's coding one.
 *
 * Windows shaped the argument design: pi ships as a `.cmd` shim there, so the
 * spawn goes through `cmd.exe /d /c`, and cmd is a *parser*, not a pipe — a
 * newline inside an argument ends the command line (everything after it is
 * lost), `"` re-splits arguments and `%NAME%` is env-expanded. Both payloads
 * here are multi-line by nature (the prompt and the `User:/Assistant:`
 * excerpt), so neither may ride on argv: the system prompt stays a single
 * quote-free line and the excerpt travels on stdin.
 */
object TitleGenerator {
    private val LOG = Logger.getInstance(TitleGenerator::class.java)

    private const val TIMEOUT_SECONDS = 30L
    private const val USER_CLIP = 800
    private const val ASSISTANT_CLIP = 400

    /**
     * Deliberately one line, with no `"` and no `%`: on Windows this string is
     * an argument of a `cmd /c` command line, where a line break truncates the
     * whole command and a quote would re-split the arguments.
     */
    private val SYSTEM_PROMPT = "You generate concise titles for coding-assistant conversations. " +
        "Reply with ONLY the title on a single line: no quotes, no surrounding punctuation, " +
        "no explanation. At most 6 words, or 12 characters when writing Chinese/Japanese/Korean. " +
        "Use the same language as the user's message."

    /** `{title: …}` on success, `{error: …}` otherwise — never throws. */
    fun generate(
        piPath: String,
        user: String,
        assistant: String,
        provider: String?,
        modelId: String?,
    ): JsonObject {
        if (user.isBlank() || assistant.isBlank()) {
            return failure("first exchange has no text to summarize")
        }
        val out = run(piPath, buildCommand(piPath, provider, modelId), prompt(user, assistant))
            ?: return failure("pi one-shot failed or timed out")
        val title = cleanOutput(out) ?: return failure("pi produced no usable title")
        return buildJsonObject { put("title", title) }
    }

    /** Visible for tests: the exact argv a title call spawns — payload-free. */
    fun buildCommand(
        piPath: String,
        provider: String?,
        modelId: String?,
    ): List<String> {
        val args = mutableListOf("--no-session", "--no-tools", "--no-extensions", "--no-mcp", "-p", "--system-prompt", SYSTEM_PROMPT)
        // Same model as the live conversation; omitted only when the UI has
        // none yet, letting pi fall back to its own defaults.
        if (!provider.isNullOrBlank() && !modelId.isNullOrBlank()) {
            args += listOf("--provider", provider, "--model", modelId)
        }
        // No message argument: `pi -p` reads the prompt from stdin, the only
        // channel cmd.exe forwards byte for byte (see the class doc).
        return PiLocator.spawnCommand(piPath, args)
    }

    /** Visible for tests: the stdin payload — the excerpt, never argv. */
    fun prompt(user: String, assistant: String): String =
        "User: ${clip(user, USER_CLIP)}\n\nAssistant: ${clip(assistant, ASSISTANT_CLIP)}\n"

    /** Visible for tests: first non-blank line, unwrapped quotes, flattened. */
    fun cleanOutput(raw: String): String? {
        val line = raw.lineSequence().firstOrNull { it.isNotBlank() }?.trim() ?: return null
        var body = line
        if (body.length >= 2) {
            val quotes = "\"'`“”‘’「『"
            if (quotes.contains(body.first()) && quotes.contains(body.last())) {
                body = body.substring(1, body.length - 1).trim()
            }
        }
        return body.replace(Regex("\\s+"), " ").trim().takeIf { it.isNotEmpty() }
    }

    /** Code-point clip — CJK text must not be cut mid-character. */
    private fun clip(s: String, max: Int): String =
        if (s.codePointCount(0, s.length) <= max) s else s.substring(0, s.offsetByCodePoints(0, max))

    /**
     * Output captured to a temp FILE with the process exit code: pi routes
     * provider failures to stderr, and a capture without the exit check would
     * happily hand back "API key not found" as a session title.
     *
     * Three real-machine failures shaped this method, all invisible from the
     * caller (no response, no log — the bridge coroutine just never returned):
     * 1. stdin: a GUI-launched IDE has no TTY, and ProcessBuilder children
     *    inherit the IDE's never-EOF stdin pipe — `pi -p` then waits on stdin
     *    forever (terminal repro: /dev/null stdin 3s, open-pipe stdin >12s).
     *    The temp file gives it the EOF it wants, and doubles as the prompt
     *    channel so the excerpt needs no place on the command line.
     * 2. stdout: a pipe read after a killed one-shot blocked forever on an
     *    orphaned child holding the write end. A file cannot hang, and the
     *    tree kill keeps no orphans alive either.
     * 3. PATH: on Windows pi is a `.cmd` shim that resolves `node` itself, and
     *    a GUI-launched IDE's PATH need not contain node (repro: exit 9009,
     *    "Pi could not find Node.js"), so the child gets the same PATH merge
     *    as the live session.
     */
    private fun run(piPath: String, command: List<String>, stdinText: String): String? {
        val outFile = File.createTempFile("pi-title-", ".txt")
        val inFile = File.createTempFile("pi-title-in-", ".txt")
        try {
            inFile.writeText(stdinText, Charsets.UTF_8)
            val pb = ProcessBuilder(command)
                .redirectInput(ProcessBuilder.Redirect.from(inFile))
                .redirectOutput(ProcessBuilder.Redirect.to(outFile))
                .redirectErrorStream(true)
            OsProcess.augmentPathEnv(pb, listOfNotNull(PiLocator.nodeBinDirFor(piPath)))
            val proc = pb.start()
            val finished = proc.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            if (!finished) {
                proc.descendants().forEach { it.destroyForcibly() }
                proc.destroyForcibly()
                LOG.warn("title.generate: pi one-shot timed out after ${TIMEOUT_SECONDS}s")
                return null
            }
            val out = OsProcess.decodeOutput(outFile.readBytes())
            if (proc.exitValue() != 0) {
                LOG.warn("title.generate: pi exited ${proc.exitValue()}: ${out.take(200)}")
                return null
            }
            return out
        } catch (e: Exception) {
            LOG.warn("title.generate: spawn failed: ${e.message}")
            return null
        } finally {
            outFile.delete()
            inFile.delete()
        }
    }

    private fun failure(message: String): JsonObject = buildJsonObject { put("error", message) }
}
