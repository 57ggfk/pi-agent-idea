package dev.pi.agent.manage

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import dev.pi.agent.process.OsProcess
import dev.pi.agent.process.PiLocator
import dev.pi.agent.settings.PiAgentSettings
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

/**
 * First-run environment detection and the guided install it leads to.
 *
 * The plugin cannot work without two things the IDE does not guarantee: a node
 * runtime (pi is a node CLI) and pi itself. Both used to surface only as
 * "pi process is not running" while the user had no idea what to install or
 * where. This object answers, in one round trip, "what is on this machine",
 * and can install pi through npm: by default with no registry override at all
 * (so a corporate `.npmrc` or proxy keeps working), or pinned to the official
 * registry, the China mirror, or any URL the user pastes.
 *
 * Detection never installs anything: it only reports, so the UI can show the
 * user exactly what is missing before touching their global npm prefix.
 */
object PiEnvironment {

    private val LOG = Logger.getInstance(PiEnvironment::class.java)

    /** npm package that provides the pi CLI. */
    const val PI_PACKAGE = "@earendil-works/pi-coding-agent"

    /** Honour whatever npm is configured with — pass no `--registry` at all. */
    const val SOURCE_DEFAULT = "default"

    /** Registry the user pastes in; [normalizeCustomRegistry] vets it. */
    const val SOURCE_CUSTOM = "custom"

    const val OFFICIAL_REGISTRY = "https://registry.npmjs.org"
    const val CHINA_REGISTRY = "https://registry.npmmirror.com"

    /**
     * Registries offered at setup time. [SOURCE_DEFAULT] comes first and
     * deliberately maps to an empty string: the machine may already point at a
     * corporate npm registry (`.npmrc`, `npm config set registry`) or a proxy,
     * and pinning npmjs.org would break exactly those users. The China mirror
     * is the fallback for networks where npmjs.org does not resolve.
     */
    val SOURCES: List<Pair<String, String>> = listOf(
        SOURCE_DEFAULT to "",
        "official" to OFFICIAL_REGISTRY,
        "china" to CHINA_REGISTRY,
    )

    const val DEFAULT_SOURCE = SOURCE_DEFAULT

    /** The install method the bridge was asked to run ("registry" = npm). */
    const val SOURCE_SCRIPT = "script"

    /**
     * pi 1.5.0 requires Node ≥ 22.19 (its release notes; the bundled README
     * agrees). The old `MIN_NODE_MAJOR = 18` let node 18/20 machines install
     * pi that then failed to start with a wall of syntax errors — comparing
     * major.minor against 22.19 is the corrected gate (028 FR-003).
     */
    const val MIN_NODE = "22.19"

    /**
     * major.minor comparison against [MIN_NODE]. `v` prefix tolerated, patch
     * ignored, anything unparseable is NOT ok (a broken -v output must not
     * read as a working node).
     */
    fun nodeMeetsMin(version: String): Boolean {
        val m = Regex("""v?(\d+)\.(\d+)""").find(version.trim()) ?: return false
        val major = m.groupValues[1].toIntOrNull() ?: return false
        val minor = m.groupValues[2].toIntOrNull() ?: return false
        val min = MIN_NODE.split(".").map { it.toInt() }
        return major > min[0] || (major == min[0] && minor >= min[1])
    }

    private const val VERSION_TIMEOUT_SECONDS = 15L

    /**
     * The single npm install in flight, if any. Installs are unbounded — a cold
     * one over a slow mirror takes tens of minutes — so the process handle has
     * to be reachable from another bridge request for "stop" to work at all.
     */
    @Volatile
    private var installProcess: Process? = null

    @Volatile
    private var installing = false

    @Volatile
    private var installCancelled = false

    private val installGuard = Any()

    /** Claims the install slot; false when another install is already running. */
    private fun beginInstall(): Boolean = synchronized(installGuard) {
        if (installing) {
            false
        } else {
            installing = true
            installCancelled = false
            installProcess = null
            true
        }
    }

    private fun endInstall() = synchronized(installGuard) {
        installing = false
        installProcess = null
        installCancelled = false
    }

    /**
     * Stops the running install (npm plus its children). Returns "nothing to
     * stop" rather than throwing: the UI may click Stop just as npm exits.
     */
    fun cancelInstall(): JsonObject {
        if (!installing) {
            return buildJsonObject { put("ok", false); put("error", "no install is running") }
        }
        installCancelled = true
        LOG.info("pi install cancelled by the user")
        // The process may not have started yet (the click landed between claim
        // and spawn); install() then sees the flag and kills it right away.
        installProcess?.let { proc ->
            // Grandchildren (npm spawns node) outlive a plain destroy on some
            // platforms and would keep writing into the prefix.
            runCatching { proc.toHandle().descendants().forEach { it.destroyForcibly() } }
            proc.destroyForcibly()
        }
        return buildJsonObject { put("ok", true); put("cancelled", true) }
    }

    /** Registry of a named source; empty string means "let npm decide". */
    fun registryFor(source: String?): String =
        SOURCES.firstOrNull { it.first == source }?.second ?: ""

    /**
     * Cleans up a pasted registry URL. Returns null when it cannot be a registry
     * at all, so the UI can say so instead of letting npm fail with EAI_AGAIN
     * twenty seconds later.
     *
     * Accepts a bare host (`registry.example.com`, https is assumed) and keeps
     * an explicit `http://` so on-prem mirrors on plain HTTP still work. Only
     * http(s) is allowed: `--registry` with a `file:` or `git:` value is never
     * what the user meant, and would make npm do something surprising.
     */
    fun normalizeCustomRegistry(raw: String?): String? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        val url = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else if (trimmed.contains("://")) {
            return null
        } else {
            // Bare host: https for anything routable, plain http for a local
            // registry (verdaccio, `npx local-npm`) that almost never has TLS.
            val loopback = trimmed.substringBefore('/').let {
                it.startsWith("localhost") || it.startsWith("127.") || it.startsWith("[::1]")
            }
            if (loopback) "http://$trimmed" else "https://$trimmed"
        }
        // Host must look like a host: no spaces, no credentials, at least one
        // dot or a port (registry.local:8080) — this is what catches a pasted
        // `.npmrc` line or an npm command instead of a URL.
        val body = url.substringAfter("://")
        val host = body.substringBefore('/')
        if (body.any { it.isWhitespace() }) return null
        if (host.contains('@')) return null
        if (!host.contains('.') && !host.contains(':')) return null
        return url.trimEnd('/')
    }

    /**
     * Effective `--registry` value for an install request. null means "pass no
     * flag" (npm's own configuration wins). An unusable custom value also
     * yields null here — [install] reports the validation error before running.
     */
    fun resolveRegistry(source: String?, custom: String?): String? =
        if (source == SOURCE_CUSTOM) normalizeCustomRegistry(custom)
        else registryFor(source).takeIf { it.isNotEmpty() }

    /** `npm install -g <pi> [--registry=<registry>]`, as argv (never a shell). */
    fun installArgs(npmPath: String, registry: String?): List<String> =
        buildList {
            addAll(listOf(npmPath, "install", "-g", PI_PACKAGE))
            registry?.takeIf { it.isNotBlank() }?.let { add("--registry=$it") }
        }

    /**
     * Environment snapshot for the UI: node, npm, pi, plus everything needed to
     * decide whether installing is possible at all.
     */
    fun detect(
        locate: (Boolean) -> dev.pi.agent.process.PiInstallation? = { force -> PiLocator.locate(force) },
        nodePath: () -> String? = { PiLocator.locateNode() },
        npmPath: () -> String? = { PiLocator.locateNpm() },
        versionOf: (String, List<String>) -> String? = ::toolVersion,
        configuredRegistry: (String) -> String? = ::npmConfiguredRegistry,
    ): JsonObject {
        val install = locate(true)
        val node = nodePath()
        val npm = npmPath()
        val nodeVersion = node?.let { versionOf(it, listOf(it, "-v")) } ?: ""
        val npmVersion = npm?.let { versionOf(it, listOf(it, "-v")) } ?: ""
        val nodeMajor = nodeMajorOf(nodeVersion)
        val npmRegistry = npm?.let { configuredRegistry(it) }.orEmpty()
        val nodeOk = nodeMeetsMin(nodeVersion)
        // FR-009: WHY the automatic install cannot run — three distinct
        // states instead of one misleading "npm not found".
        val blocker = when {
            node == null -> "no-node"
            !nodeOk -> "node-version"
            npm == null -> "no-npm"
            else -> null
        }

        return buildJsonObject {
            put("ok", true)
            put("node", tool(node, nodeVersion))
            put("npm", tool(npm, npmVersion))
            put("pi", tool(install?.path, install?.version ?: ""))
            put("nodeMajor", nodeMajor)
            put("nodeVersion", nodeVersion)
            put("nodeOk", nodeOk)
            put("minNode", MIN_NODE)
            put("installBlocker", blocker ?: "")
            put("scriptSupported", true)
            // npm is the install vehicle; without it the only option is a
            // manual path, which the UI must say instead of offering a button
            // that cannot work.
            put("canInstall", npm != null && nodeOk)
            put("piPackage", PI_PACKAGE)
            put("agentDir", PiCliRunner.agentDir().absolutePath)
            put("customPath", customPiPath() ?: "")
            put("sources", buildJsonArray {
                SOURCES.forEach { (id, registry) ->
                    add(buildJsonObject { put("id", id); put("registry", registry) })
                }
            })
            put("defaultSource", DEFAULT_SOURCE)
            put("customSource", SOURCE_CUSTOM)
            // What `npm config get registry` says right now, so the "npm
            // default" option can show the concrete URL it would use instead of
            // being an unexplained blank.
            put("npmRegistry", npmRegistry)
            put("needsSetup", install == null)
        }
    }

    /**
     * `npm install -g pi` through [source], or through [customRegistry] when the
     * source is [SOURCE_CUSTOM]. Blocking with **no time limit** — the caller
     * runs on a pooled bridge thread, and a cold install over a slow mirror is
     * minutes-to-tens-of-minutes. It only ends when npm ends or the user calls
     * [cancelInstall].
     *
     * When neither yields a registry the flag is omitted entirely and npm's own
     * configuration decides — the only correct behaviour on a machine pointed at
     * a corporate registry or a proxy.
     *
     * The located installation is refreshed afterwards so the version shown in
     * the UI comes from the binary that was just installed, never from a guess.
     */
    fun install(
        source: String?,
        customRegistry: String? = null,
        npmPath: () -> String? = { PiLocator.locateNpm() },
        nodePath: () -> String? = { PiLocator.locateNode() },
        runner: (ProcessBuilder) -> CliResult = { pb ->
            PiCliRunner.runProcessUntilExit(pb) { proc -> installProcess = proc }
        },
        refresh: () -> dev.pi.agent.process.PiInstallation? = {
            PiLocator.locate(forceRefresh = true)
        },
    ): JsonObject {
        if (source == SOURCE_CUSTOM && normalizeCustomRegistry(customRegistry) == null) {
            return error(
                "that registry does not look like a URL — expected something like " +
                    "https://registry.example.com (a bare host works too, https is assumed)",
            )
        }
        val npm = npmPath()
            ?: return error("npm was not found on this machine, so pi cannot be installed automatically")
        if (!beginInstall()) {
            return error("an install is already running — stop it first")
        }
        try {
            val node = nodePath()
            val registry = resolveRegistry(source, customRegistry)
            val command = OsProcess.launchCommand(installArgs(npm, registry))

            val pb = ProcessBuilder(command).redirectErrorStream(true)
            OsProcess.augmentPathEnv(pb, listOfNotNull(node?.let { File(it).parent }))
            LOG.info("installing $PI_PACKAGE via $npm (registry: ${registry ?: "npm default"})")

            val result = runner(pb)
            val output = (result.stdout + "\n" + result.stderr).trim()
            if (installCancelled) {
                LOG.info("pi install stopped by the user")
                return buildJsonObject {
                    put("ok", false)
                    put("cancelled", true)
                    put("registry", registry ?: "")
                    put("output", output.take(4000))
                    put(
                        "error",
                        "Install stopped. Nothing was uninstalled — an interrupted npm run may " +
                            "leave a partial package, so re-run it or set pi's path manually.",
                    )
                }
            }
            if (!result.success) {
                LOG.warn("pi install failed (exit ${result.exitCode}): $output")
                return buildJsonObject {
                    put("ok", false)
                    put("exitCode", result.exitCode)
                    put("registry", registry ?: "")
                    put("output", output.take(4000))
                    put("error", installFailureHint(result.exitCode, output))
                }
            }

            val installed = refresh()
            LOG.info("pi installed at ${installed?.path ?: "?"} (version ${installed?.version ?: "?"})")
            return buildJsonObject {
                put("ok", installed != null)
                put("exitCode", result.exitCode)
                put("registry", registry ?: "")
                put("output", output.take(4000))
                put("found", installed != null)
                put("path", installed?.path ?: "")
                put("version", installed?.version ?: "")
                if (installed == null) {
                    put(
                        "error",
                        "npm reported success but pi is still not on PATH — set its path manually below",
                    )
                }
            }
        } finally {
            endInstall()
        }
    }

    /**
     * 028: the vendor install script — `irm https://pi.dev/install.ps1 | iex`
     * on Windows, `curl -fsSL https://pi.dev/install.sh | sh` elsewhere. The
     * script installs its own Node, which is the whole point: this is the only
     * automatic path on a machine without one. It shares the npm channel's
     * single-flight/stop/output contract ([beginInstall]/[cancelInstall]/the
     * same runner) so the UI treats both identically (FR-007).
     */
    fun installScriptArgs(isWindows: Boolean): List<String> =
        if (isWindows) {
            listOf(
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "irm https://pi.dev/install.ps1 | iex",
            )
        } else {
            listOf("sh", "-c", "curl -fsSL https://pi.dev/install.sh | sh")
        }

    fun installScript(
        runner: (ProcessBuilder) -> CliResult = { pb ->
            PiCliRunner.runProcessUntilExit(pb) { proc -> installProcess = proc }
        },
        refresh: () -> dev.pi.agent.process.PiInstallation? = { PiLocator.locate(forceRefresh = true) },
    ): JsonObject {
        if (!beginInstall()) {
            return error("an install is already running — stop it first")
        }
        try {
            val args = installScriptArgs(OsProcess.isWindows)
            val pb = ProcessBuilder(args)
            LOG.info("installing $PI_PACKAGE via the official script")
            val result = runner(pb)
            val output = (result.stdout + "\n" + result.stderr).trim()
            if (installCancelled) {
                LOG.info("pi script install stopped by the user")
                return buildJsonObject {
                    put("ok", false)
                    put("cancelled", true)
                    put("method", SOURCE_SCRIPT)
                    put("output", output.take(4000))
                    put("error", "Install stopped. Nothing was uninstalled — re-run it or set pi's path manually.")
                }
            }
            if (!result.success) {
                LOG.warn("pi script install failed (exit ${result.exitCode})")
                return buildJsonObject {
                    put("ok", false)
                    put("exitCode", result.exitCode)
                    put("method", SOURCE_SCRIPT)
                    put("output", output.take(4000))
                    put("error", installFailureHint(result.exitCode, output))
                }
            }
            val installed = refresh()
            return buildJsonObject {
                put("ok", installed != null)
                put("exitCode", result.exitCode)
                put("method", SOURCE_SCRIPT)
                put("output", output.take(4000))
                put("found", installed != null)
                put("path", installed?.path ?: "")
                put("version", installed?.version ?: "")
                if (installed == null) {
                    put(
                        "error",
                        "the script finished but pi is still not on PATH — re-detect or set its path manually below",
                    )
                }
            }
        } finally {
            endInstall()
        }
    }

    /**
     * Manual path (Settings → Tools → Pi Agent has the same effect, this is the
     * in-flow shortcut). Rejects anything that is not an existing file so a
     * typo cannot turn into "pi process is not running" later.
     */
    fun setPiPath(params: JsonObject, onChanged: () -> Unit = { PiAgentSettings.restartPiEverywhere() }): JsonObject {
        val raw = (params["path"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.trim()
        if (raw.isNullOrEmpty()) {
            settings()?.setCustomPiPath(null)
            onChanged()
            return buildJsonObject { put("ok", true); put("cleared", true) }
        }
        val file = File(raw)
        if (!file.isFile) {
            return error("not a file: $raw")
        }
        settings()?.setCustomPiPath(file.absolutePath)
        val install = PiLocator.locate(forceRefresh = true)
        onChanged()
        return buildJsonObject {
            put("ok", install != null)
            put("path", install?.path ?: file.absolutePath)
            put("version", install?.version ?: "")
            if (install == null) put("error", "pi could not be started from $raw")
        }
    }

    /**
     * 028 FR-004/FR-006: store the explicit Node interpreter (empty clears it
     * back to "discover") and restart pi everywhere, same contract as
     * [setPiPath]. The value is re-checked by [PiLocator.locateNode] on use.
     */
    fun setNodePath(params: JsonObject, onChanged: () -> Unit = { PiAgentSettings.restartPiEverywhere() }): JsonObject {
        val raw = (params["path"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.trim()
        if (raw.isNullOrEmpty()) {
            settings()?.setNodePath(null, onChanged)
            return buildJsonObject { put("ok", true); put("cleared", true) }
        }
        val file = File(raw)
        if (!file.isFile) {
            return error("not a file: $raw")
        }
        settings()?.setNodePath(file.absolutePath, onChanged)
        return buildJsonObject {
            put("ok", true)
            put("path", file.absolutePath)
            put("version", toolVersion(file.absolutePath, listOf(file.absolutePath, "-v")) ?: "")
        }
    }

    private fun customPiPath(): String? = settings()?.customPiPath()

    private fun settings(): PiAgentSettings? =
        ApplicationManager.getApplication()?.getService(PiAgentSettings::class.java)

    private fun nodeMajorOf(version: String): Int? =
        Regex("""v?(\d+)\.""").find(version.trim())?.groupValues?.getOrNull(1)?.toIntOrNull()

    private fun tool(path: String?, version: String): JsonObject = buildJsonObject {
        put("found", path != null)
        put("path", path ?: "")
        put("version", version)
    }

    private fun error(message: String): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", message)
    }

    /**
     * One line the user can act on, on top of the raw npm output (spec 008
     * T017: the wrapper line is translated; npm's own output never is).
     */
    private fun installFailureHint(exitCode: Int, output: String): String {
        val lower = output.lowercase()
        return when {
            lower.contains("eacces") || lower.contains("permission denied") ->
                dev.pi.agent.PiAgentBundle.message("install.hint.eacces")
            // Network-shaped failures: no DNS, refused, reset, a quiet proxy
            // answering 502/504 (what an internal gateway actually returns),
            // or any of that surfacing as a timeout after retries.
            listOf(
                "etimedout", "enotfound", "econnrefused", "econnreset", "eai_again",
                "eproxy", "e502", "e503", "e504", "network", "socket hang up",
            ).any { lower.contains(it) } ->
                dev.pi.agent.PiAgentBundle.message("install.hint.network")
            lower.contains("eexist") ->
                dev.pi.agent.PiAgentBundle.message("install.hint.eexist")
            exitCode == -1 ->
                dev.pi.agent.PiAgentBundle.message("install.hint.timeout")
            else -> dev.pi.agent.PiAgentBundle.message("install.hint.generic")
        }
    }

    /** `<tool> -v`, trimmed; null when the tool does not run. */
    private fun toolVersion(path: String, command: List<String>): String? = runCatching {
        val parent = File(path).parentFile ?: return@runCatching null
        val pb = ProcessBuilder(OsProcess.launchCommand(command)).redirectErrorStream(true)
        OsProcess.augmentPathEnv(pb, listOf(parent.absolutePath))
        val result = PiCliRunner.runProcess(pb, VERSION_TIMEOUT_SECONDS)
        (result.stdout + result.stderr).trim().lineSequence().firstOrNull { it.isNotBlank() }
    }.getOrNull()

    /**
     * `npm config get registry` — the URL npm would use with no `--registry`
     * flag. Shown next to the "npm default" option so the choice is concrete.
     * Any failure (old npm, broken config) just means "unknown", never an error.
     */
    private fun npmConfiguredRegistry(npmPath: String): String? = runCatching {
        val parent = File(npmPath).parentFile ?: return@runCatching null
        val pb = ProcessBuilder(OsProcess.launchCommand(listOf(npmPath, "config", "get", "registry")))
            .redirectErrorStream(true)
        OsProcess.augmentPathEnv(pb, listOf(parent.absolutePath))
        PiCliRunner.runProcess(pb, VERSION_TIMEOUT_SECONDS)
            .stdout
            .lineSequence()
            .map { it.trim() }
            .firstOrNull { it.startsWith("http://") || it.startsWith("https://") }
    }.getOrNull()
}
