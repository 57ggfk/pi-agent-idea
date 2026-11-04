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
     * Spawnable form of [command]: a `.cmd`/`.bat` executable on Windows is
     * wrapped in `cmd /c …` (CreateProcess refuses them on recent JDKs);
     * anything else passes through unchanged.
     */
    fun launchCommand(command: List<String>): List<String> {
        val head = command.firstOrNull() ?: return command
        return if (isCmdLike(head)) listOf("cmd", "/c") + command else command
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
