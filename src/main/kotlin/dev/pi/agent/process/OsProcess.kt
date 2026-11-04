package dev.pi.agent.process

import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * Cross-platform process helpers.
 *
 * Windows differences handled here: `.cmd`/`.bat` shims (as produced by
 * `npm install -g`) cannot be exec'd directly by recent JDKs and must go
 * through `cmd /c`, and the PATH environment separator is `;` rather than
 * `:`. Everything else in the plugin spawns processes through this object.
 */
object OsProcess {

    val isWindows: Boolean =
        System.getProperty("os.name")?.lowercase()?.contains("windows") == true

    /**
     * Charset of *native tool* output on this machine: `where`, `dir` and
     * friends print in the ANSI/OEM code page (`GBK` on zh-CN Windows), not in
     * UTF-8. The JVM default charset is UTF-8 since JDK 18, so decoding their
     * output with the default turns a Chinese install path such as
     * `D:\软件\nodejs\pi.cmd` into `D:\????\nodejs\pi.cmd`, and the resulting
     * "Cannot run program" failure looks like a broken install.
     *
     * `native.encoding` (JEP 400) is exactly this code page. JCEF/pi output,
     * by contrast, is UTF-8 — [decodeOutput] tells the two apart per read.
     */
    val nativeCharset: Charset = runCatching {
        Charset.forName(System.getProperty("native.encoding") ?: "UTF-8")
    }.getOrDefault(Charsets.UTF_8)

    /**
     * Decodes captured process output: UTF-8 when the bytes are valid UTF-8
     * (pi itself, node, our own tools), otherwise the native code page (native
     * Windows utilities), never the lossy replacement-character path.
     */
    fun decodeOutput(bytes: ByteArray): String {
        if (bytes.isEmpty()) return ""
        val strict = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            strict.decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: CharacterCodingException) {
            String(bytes, nativeCharset)
        }
    }

    /** True when [path] is a Windows cmd shim that must run via `cmd /c`. */
    fun isCmdLike(path: String): Boolean {
        if (!isWindows) return false
        val lower = path.lowercase()
        return lower.endsWith(".cmd") || lower.endsWith(".bat")
    }

    /**
     * Absolute path to the command interpreter that runs `.cmd`/`.bat` shims.
     *
     * Never the bare name `cmd`. CreateProcess resolves a bare name against
     * the *parent process's* own search path, so a stale entry (a same-named
     * file, a directory, a shell wrapper) is enough to turn a perfectly good
     * interpreter into
     * `CreateProcess error=193, %1 is not a valid Win32 application` — and the
     * failure then looks like "pi is broken" while the same command works in
     * an external terminal. `ComSpec` is what Windows itself uses; the
     * well-known location is only a fallback for processes started with a
     * stripped environment.
     */
    val windowsShell: String by lazy { resolveWindowsShell() }

    private fun resolveWindowsShell(): String {
        val candidates = listOfNotNull(
            System.getenv("ComSpec"),
            System.getenv("SystemRoot")?.let { "$it\\System32\\cmd.exe" },
            System.getenv("windir")?.let { "$it\\System32\\cmd.exe" },
            "C:\\Windows\\System32\\cmd.exe",
        )
        return candidates.asSequence()
            .map { it.trim().trim('"') }
            .firstOrNull { it.isNotEmpty() && File(it).isFile }
            // Nothing found: keep the old behaviour rather than refusing to
            // start at all — the error message is clearer than a silent skip.
            ?: "cmd"
    }

    /**
     * Spawnable form of [command]: a `.cmd`/`.bat` executable on Windows is
     * wrapped in `<absolute cmd.exe> /d /c …` (CreateProcess refuses them on
     * recent JDKs); anything else passes through unchanged.
     *
     * `/d` skips the `Command Processor\AutoRun` hook — on a machine with a
     * conda/nvm hook installed every invocation costs ~200 ms and, worse,
     * that hook may rewrite `PATH`, which is exactly what `where pi` and
     * `where node` are asked to resolve. pi and npm need none of it.
     */
    fun launchCommand(command: List<String>): List<String> {
        val head = command.firstOrNull() ?: return command
        return if (isCmdLike(head)) listOf(windowsShell, "/d", "/c") + command else command
    }

    /**
     * Prepends [extraDirs] to the child's PATH using the OS-correct separator.
     * Order matters: node's dir goes first so pi and its MCP servers resolve
     * node even when the IDE was launched from a GUI with a minimal PATH.
     */
    fun augmentPathEnv(pb: ProcessBuilder, extraDirs: List<String>) {
        val env = pb.environment()
        val dirs = (extraDirs.map { it.trim() } + (env["PATH"] ?: ""))
            .filter { it.isNotBlank() }
            .distinct()
        env["PATH"] = dirs.joinToString(File.pathSeparator)
    }
}
