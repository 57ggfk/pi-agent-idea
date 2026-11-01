package dev.pi.agent.process

import java.io.File

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
