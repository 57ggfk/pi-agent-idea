package dev.pi.agent.process

import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.util.concurrent.TimeUnit

/** A located pi CLI installation. */
data class PiInstallation(val path: String, val version: String?)

/**
 * Finds the pi CLI on this machine, on macOS, Windows and Linux alike.
 *
 * Order: explicit `PI_AGENT_EXECUTABLE` env var (used by tests) → the custom
 * path from Settings → Tools → Pi Agent → discovery via the login shell's
 * PATH (Unix: covers nvm/volta installs invisible to GUI-launched IDEs) or
 * `where pi` (Windows) → well-known locations.
 */
object PiLocator {

    private val LOG = Logger.getInstance(PiLocator::class.java)

    @Volatile
    private var cached: PiInstallation? = null

    fun locate(forceRefresh: Boolean = false): PiInstallation? {
        if (!forceRefresh) {
            cached?.let { return it }
        }
        val found = doLocate()
        cached = found
        return found
    }

    private fun doLocate(): PiInstallation? {
        // Only requires a readable file: on Windows, canExecute() is unreliable
        // for scripts (and the e2e mock injects a .mjs here).
        System.getenv("PI_AGENT_EXECUTABLE")?.let { envPath ->
            val f = File(envPath)
            if (f.isFile) {
                return PiInstallation(f.absolutePath, version(f.absolutePath))
            }
            LOG.warn("PI_AGENT_EXECUTABLE is set but not a file: $envPath")
        }

        // Explicit user setting (Settings → Tools → Pi Agent) — the documented
        // escape hatch for machines where discovery fails. It never overrides
        // the env var above so test/e2e injection keeps working. Skipped when
        // no application is present (plain unit tests).
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        if (app != null) {
            app.getService(dev.pi.agent.settings.PiAgentSettings::class.java).customPiPath()?.let { settingPath ->
                val f = File(settingPath)
                if (f.isFile) {
                    return PiInstallation(f.absolutePath, version(f.absolutePath))
                }
                LOG.warn("custom pi path is set but not a file: $settingPath")
            }
        }

        if (OsProcess.isWindows) {
            // `where pi` resolves npm-global/scoop installs reachable from the
            // IDE process PATH; prefer .cmd/.exe shims over the extensionless
            // git-bash shim `where` may also list.
            val whereResults = windowsWhere("pi").orEmpty()
            val best = whereResults.firstOrNull { OsProcess.isCmdLike(it) || it.lowercase().endsWith(".exe") }
                ?: whereResults.firstOrNull()
            best?.let { return foundAt(it) }
        } else {
            loginShellPath()
                .map { dir -> File(dir, "pi") }
                .firstOrNull { isLaunchable(it) }
                ?.let { return foundAt(it.absolutePath) }
        }

        for (candidate in candidatePaths()) {
            val f = File(candidate)
            if (isLaunchable(f)) {
                return foundAt(f.absolutePath)
            }
        }
        return null
    }

    private fun foundAt(path: String): PiInstallation = PiInstallation(path, version(path))

    /** `pi --version` output, or null when the binary is not runnable. */
    fun version(path: String): String? = runCapture(OsProcess.launchCommand(listOf(path, "--version")), 10)
        ?.lineSequence()
        ?.firstOrNull { it.isNotBlank() }
        ?.trim()

    /**
     * Resolves the node interpreter that runs pi, for pi distributions that
     * are node scripts (`#!/usr/bin/env node` — all npm installs, and the
     * e2e mock's .mjs).
     *
     * GUI-launched IDEs inherit a minimal PATH without node, so spawning pi
     * directly dies with "env: node: No such file or directory". We search
     * upwards from pi's canonical location (npm layout keeps node a few
     * levels up, e.g. <nvm-root>/bin/node), then the login-shell PATH (Unix),
     * then well-known Windows locations.
     */
    fun nodeInterpreterFor(piPath: String): String? {
        val nodeNames = if (OsProcess.isWindows) listOf("node.exe") else listOf("node", "bin/node")
        val canonical = try {
            File(piPath).canonicalFile
        } catch (_: Exception) {
            File(piPath)
        }
        var dir: File? = canonical.parentFile
        var depth = 0
        while (dir != null && depth < 7) {
            for (name in nodeNames) {
                File(dir, name).takeIf { it.isFile && it.canExecute() }?.let { return it.absolutePath }
            }
            dir = dir.parentFile
            depth++
        }
        for (pathDir in loginShellPath()) {
            for (name in nodeNames) {
                File(pathDir, name).takeIf { it.isFile && it.canExecute() }?.let { return it.absolutePath }
            }
        }
        if (OsProcess.isWindows) return windowsNode()
        return null
    }

    /** True when [piPath] is a script that needs a node interpreter. */
    fun isNodeScript(piPath: String): Boolean = try {
        val f = File(piPath)
        when {
            OsProcess.isWindows ->
                // .cmd/.bat shims resolve node themselves; bare .mjs/.js
                // (e.g. the e2e mock) must be handed to a node interpreter.
                listOf(".mjs", ".js", ".cjs").any { f.name.lowercase().endsWith(it) }
            else -> f.inputStream().bufferedReader(Charsets.UTF_8).useLines { lines ->
                lines.firstOrNull()?.contains("node") == true
            }
        }
    } catch (_: Exception) {
        false
    }

    /**
     * Full spawn command for pi: [node, piPath, args…] when pi is a node
     * script and its interpreter was found, otherwise [piPath, args…]; .cmd
     * shims on Windows are additionally wrapped in `cmd /c` (see
     * [OsProcess.launchCommand]).
     */
    fun spawnCommand(piPath: String, args: List<String>): List<String> {
        val base = if (isNodeScript(piPath)) {
            nodeInterpreterFor(piPath)?.let { listOf(it, piPath) } ?: listOf(piPath)
        } else {
            listOf(piPath)
        }
        return OsProcess.launchCommand(base) + args
    }

    /** Directory containing the resolved node interpreter, for child PATHs. */
    fun nodeBinDirFor(piPath: String): String? =
        nodeInterpreterFor(piPath)?.let { File(it).parent }

    /**
     * Node runtime reachable from the IDE, or null. Same discovery rules as
     * pi's own interpreter search, but standalone: the first-run check has to
     * answer "is node installed at all" before any pi path exists.
     */
    fun locateNode(): String? = if (OsProcess.isWindows) {
        windowsNode()
    } else {
        loginShellPath()
            .map { File(it, "node") }
            .firstOrNull { isLaunchable(it) }
            ?.absolutePath
    }

    /** npm client (the install vehicle offered on first run), or null. */
    fun locateNpm(): String? = if (OsProcess.isWindows) {
        windowsWhere("npm")
            ?.firstOrNull { it.lowercase().endsWith(".cmd") || it.lowercase().endsWith(".exe") }
            ?: windowsWhere("npm")?.firstOrNull()
    } else {
        loginShellPath()
            .map { File(it, "npm") }
            .firstOrNull { isLaunchable(it) }
            ?.absolutePath
    }

    /**
     * Directories of the user's login shell PATH (Unix only; Windows has no
     * login shell and relies on `where` + well-known dirs instead). Resolving
     * this is essential because IDEs launched from the Dock/Finder inherit a
     * minimal PATH that typically misses nvm-managed tools like pi.
     */
    fun loginShellPath(): List<String> {
        if (OsProcess.isWindows) return emptyList()
        val now = System.currentTimeMillis()
        shellPathCache?.let { (at, dirs) -> if (now - at < SHELL_PATH_TTL_MS) return dirs }
        val out = runCapture(listOf(unixShell(), "-lic", "printf '%s' \"\$PATH\""), 10) ?: return emptyList()
        val dirs = out.split(":")
            .filter { it.isNotBlank() }
            .distinct()
        shellPathCache = now to dirs
        return dirs
    }

    /** The user's login shell, or the first installed of zsh/bash/sh. */
    private fun unixShell(): String =
        System.getenv("SHELL")?.takeIf { File(it).isFile }
            ?: listOf("/bin/zsh", "/bin/bash", "/bin/sh").firstOrNull { File(it).isFile }
            ?: "/bin/sh"

    /** Windows node discovery: `where node`, then well-known install paths. */
    private fun windowsNode(): String? {
        windowsWhere("node")?.firstOrNull()?.let { return it }
        val home = System.getProperty("user.home")
        val candidates = listOfNotNull(
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Program Files (x86)\\nodejs\\node.exe",
            System.getenv("NVM_SYMLINK")?.let { "$it\\node.exe" },
            "$home\\scoop\\apps\\nodejs\\current\\node.exe",
        )
        return candidates.firstOrNull { File(it).isFile }
    }

    /** Results of `<cmd.exe> /c where <tool>`, or null when not found. */
    private fun windowsWhere(tool: String): List<String>? =
        runCapture(listOf(OsProcess.windowsShell, "/c", "where", tool), 10)
            ?.lineSequence()
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            // A result that is not a real file is a decoding casualty, not an
            // install: accepting it would surface as "Cannot run program".
            ?.filter { File(it).isFile }
            ?.toList()
            ?.takeIf { it.isNotEmpty() }

    /** Executable-file check that tolerates Windows' lax execute bits. */
    private fun isLaunchable(f: File): Boolean {
        if (!f.isFile) return false
        if (!OsProcess.isWindows) return f.canExecute()
        val name = f.name.lowercase()
        return name.endsWith(".exe") || name.endsWith(".cmd") || name.endsWith(".bat") || f.canExecute()
    }

    private fun candidatePaths(): List<String> {
        val home = System.getProperty("user.home")
        return if (OsProcess.isWindows) {
            val appData = System.getenv("APPDATA") ?: "$home\\AppData\\Roaming"
            val programData = System.getenv("ProgramData") ?: "C:\\ProgramData"
            listOf(
                "$appData\\npm\\pi.cmd",
                "$appData\\npm\\pi.exe",
                "$appData\\npm\\pi",
                "$home\\scoop\\shims\\pi.exe",
                "$home\\scoop\\shims\\pi.cmd",
                "$programData\\chocolatey\\bin\\pi.exe",
            )
        } else {
            listOf(
                "$home/.local/bin/pi",
                "$home/bin/pi",
                "/usr/local/bin/pi",
                "/opt/homebrew/bin/pi",
            )
        }
    }

    @Volatile
    private var shellPathCache: Pair<Long, List<String>>? = null

    private fun runCapture(command: List<String>, timeoutSeconds: Long): String? = try {
        val pb = ProcessBuilder(command).redirectErrorStream(true)
        val proc = pb.start()
        val finished = proc.waitFor(timeoutSeconds, TimeUnit.SECONDS)
        if (!finished) {
            proc.destroyForcibly()
            null
        } else {
            // Native tools (`where`, `dir`) answer in the local code page while
            // pi/node answer in UTF-8; decode per byte stream instead of with
            // the JVM default (UTF-8 since JDK 18), which mangles any path
            // containing non-ASCII characters.
            OsProcess.decodeOutput(proc.inputStream.use { it.readBytes() })
        }
    } catch (e: Exception) {
        LOG.debug("failed to run ${command.first()}: ${e.message}")
        null
    }

    private const val SHELL_PATH_TTL_MS = 60_000L
}
