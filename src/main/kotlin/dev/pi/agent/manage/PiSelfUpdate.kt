package dev.pi.agent.manage

import dev.pi.agent.process.OsProcess
import dev.pi.agent.process.PiLocator
import java.io.File

/**
 * The npm fallback for pi's self-update.
 *
 * pi's own `pi update --self` refuses on some npm installations with
 * "cannot self-update this installation". The refusal is not about the
 * installation being un-updatable — it is about pi not recognising who manages
 * it. pi asks `npm root -g` and compares the answer with its own package
 * directory; on a machine with **two npm prefixes** (one first on PATH, the
 * other the one that actually installed pi) the comparison fails and pi
 * concludes that nothing manages the installation.
 *
 * The fix is to do what pi cannot: derive the prefix **from pi's own
 * installation path** and install into that prefix explicitly. An npm install
 * looks like this:
 *
 * ```
 * <prefix>/pi.cmd                                    <- the shim on PATH
 * <prefix>/node_modules/@earendil-works/pi-coding-agent/package.json
 * ```
 *
 * so the prefix is the shim's directory. `npm install -g --prefix <prefix>`
 * then writes into exactly that prefix — no matter which npm binary runs it,
 * because `--prefix` redirects the global root (verified: `npm --prefix <dir>
 * root -g` → `<dir>/node_modules`).
 *
 * The npm binary itself matters much less once `--prefix` is passed, but it
 * still has to exist. [npmFor] picks one that can see the installation: it
 * asks each candidate npm for its global root and keeps the one whose root
 * actually contains pi's package directory.
 */
object PiSelfUpdate {

    /** npm package that provides the pi CLI. */
    const val PI_PACKAGE = "@earendil-works/pi-coding-agent"

    /**
     * pi's refusal, as it prints it. The message is the only reliable signal
     * that the failure is "pi does not know who manages me" rather than a
     * genuine network or permission problem — the fallback must not mask
     * those.
     */
    private const val REFUSAL_MARKER = "cannot self-update"

    /**
     * True when pi refused to self-update because it does not recognise the
     * installation as package-managed — the one failure npm can fix.
     */
    fun isSelfUpdateRefusal(output: String): Boolean =
        output.contains(REFUSAL_MARKER, ignoreCase = true)

    /**
     * The npm prefix that owns pi, derived from pi's own path.
     *
     * The prefix is the directory holding the pi shim: npm keeps the global
     * shims and the global `node_modules` side by side. Returns null when the
     * layout is not npm's (a script install has no shim next to node_modules),
     * in which case there is nothing to fall back to.
     */
    fun prefixFor(piPath: String?): String? {
        if (piPath.isNullOrBlank()) return null
        val shim = File(piPath)
        val prefix = shim.parentFile ?: return null
        // Only a real npm layout has the package next to the shim. Anything
        // else would make us invent a prefix and install into the void.
        val pkg = File(prefix, "node_modules/$PI_PACKAGE")
        if (!pkg.isDirectory) return null
        return prefix.absolutePath
    }

    /**
     * The npm client to use for the fallback.
     *
     * Prefers an npm whose global root actually contains pi — that npm is the
     * one that manages this installation. Falls back to the first usable npm
     * when none of them claims pi, because `--prefix` still redirects the
     * install target.
     */
    fun npmFor(
        piPath: String?,
        candidates: () -> List<String>,
        globalRootOf: (String) -> String?,
    ): String? {
        val prefix = prefixFor(piPath)
        // The candidates are taken as given: discovering them (and checking
        // that they exist on this machine) is [defaultNpmCandidates]'s job.
        // Selection is the pure part, and it must be testable without a real
        // npm on disk.
        val list = candidates()
        if (list.isEmpty()) return null
        if (prefix == null) return list.first()
        val expected = File(prefix, "node_modules").absolutePath
        val owner = list.firstOrNull { npm ->
            val root = globalRootOf(npm) ?: return@firstOrNull false
            File(root).absolutePath.equals(expected, ignoreCase = true)
        }
        return owner ?: list.first()
    }

    /**
     * The fallback install command: `npm install -g --prefix <prefix>
     * <package>@latest`.
     *
     * `--prefix` is what makes this safe: it pins the install target to the
     * prefix pi actually lives in, so a stray npm elsewhere on PATH cannot
     * install a second copy somewhere the plugin will never look.
     */
    fun npmInstallArgs(npmPath: String, prefix: String, pkg: String = PI_PACKAGE): List<String> =
        listOf(npmPath, "install", "-g", "--prefix", prefix, "$pkg@latest")

    /**
     * Runs the fallback install. Returns null when no usable npm/prefix pair
     * exists — the caller then reports the original pi refusal rather than
     * pretending an update was attempted.
     */
    fun npmUpdate(
        piPath: String?,
        npmCandidates: () -> List<String> = { defaultNpmCandidates() },
        globalRootOf: (String) -> String? = ::npmGlobalRoot,
        runner: (List<String>, Long) -> CliResult = { args, timeout ->
            PiCliRunner.runProcess(
                ProcessBuilder(OsProcess.launchCommand(args)).redirectErrorStream(true),
                timeout,
            )
        },
        timeoutSeconds: Long = PiManage.UPDATE_TIMEOUT_SECONDS,
    ): CliResult? {
        val prefix = prefixFor(piPath) ?: return null
        val npm = npmFor(piPath, npmCandidates, globalRootOf) ?: return null
        val args = npmInstallArgs(npm, prefix)
        return runner(args, timeoutSeconds)
    }

    /**
     * The npm clients to try, most specific first: the npm beside the node
     * the user configured, then whatever is on PATH.
     */
    fun defaultNpmCandidates(): List<String> {
        val out = mutableListOf<String>()
        runCatching {
            dev.pi.agent.settings.PiAgentSettings.getInstance().nodePath()
        }.getOrNull()?.let { node ->
            File(node).parentFile?.let { dir ->
                listOf("npm.cmd", "npm.exe", "npm").forEach { name ->
                    File(dir, name).takeIf { it.isFile }?.let { out += it.absolutePath }
                }
            }
        }
        out += allNpmOnPath()
        return out.distinct()
    }

    /** Every npm on PATH (Windows: `where npm`; Unix: the login-shell PATH). */
    private fun allNpmOnPath(): List<String> {
        if (OsProcess.isWindows) {
            return whereNpm()
        }
        return PiLocator.loginShellPath()
            .map { File(it, "npm") }
            .filter { it.isFile }
            .map { it.absolutePath }
    }

    private fun whereNpm(): List<String> {
        val out = mutableListOf<String>()
        val result = runCatching {
            ProcessBuilder(OsProcess.launchCommand(listOf(OsProcess.windowsShell, "/d", "/c", "where", "npm")))
                .redirectErrorStream(true)
                .start()
        }.getOrNull() ?: return out
        return runCatching {
            val text = result.inputStream.bufferedReader().use { it.readText() }
            result.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)
            text.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }
                .filter { File(it).isFile }
                .toList()
        }.getOrDefault(emptyList()).also { out.addAll(it) }
    }

    /**
     * The npm global root: `npm root -g`. With `--prefix <dir>` it answers
     * `<dir>/node_modules`, which is how the prefix is verified.
     */
    fun npmGlobalRoot(npmPath: String, prefix: String? = null): String? {
        val args = buildList {
            if (prefix != null) addAll(listOf("--prefix", prefix))
            addAll(listOf("root", "-g"))
        }
        val result = runCatching {
            ProcessBuilder(OsProcess.launchCommand(listOf(npmPath) + args)).redirectErrorStream(true).start()
        }.getOrNull() ?: return null
        return runCatching {
            val text = result.inputStream.bufferedReader().use { it.readText() }
            result.waitFor(15, java.util.concurrent.TimeUnit.SECONDS)
            text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }
        }.getOrNull()
    }
}
