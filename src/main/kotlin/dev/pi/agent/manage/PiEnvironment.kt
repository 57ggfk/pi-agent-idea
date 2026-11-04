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
 * and can install pi through either npm registry — the international one, or
 * the China mirror that actually resolves on an intranet-adjacent network.
 *
 * Detection never installs anything: it only reports, so the UI can show the
 * user exactly what is missing before touching their global npm prefix.
 */
object PiEnvironment {

    private val LOG = Logger.getInstance(PiEnvironment::class.java)

    /** npm package that provides the pi CLI. */
    const val PI_PACKAGE = "@earendil-works/pi-coding-agent"

    /**
     * Registries offered at setup time. Ordered as shown in the UI: the
     * official one first, the China mirror where npmjs.org is unreachable.
     */
    val SOURCES: List<Pair<String, String>> = listOf(
        "official" to "https://registry.npmjs.org",
        "china" to "https://registry.npmmirror.com",
    )

    const val DEFAULT_SOURCE = "official"

    /** pi is published as ESM and needs a modern node; older ones install but do not run. */
    const val MIN_NODE_MAJOR = 18

    private const val VERSION_TIMEOUT_SECONDS = 15L
    private const val INSTALL_TIMEOUT_SECONDS = 300L

    fun registryFor(source: String?): String =
        SOURCES.firstOrNull { it.first == source }?.second ?: SOURCES.first().second

    /** `npm install -g <pi> --registry=<source>`, as argv (never a shell). */
    fun installArgs(npmPath: String, source: String?): List<String> =
        listOf(npmPath, "install", "-g", PI_PACKAGE, "--registry=${registryFor(source)}")

    /**
     * Environment snapshot for the UI: node, npm, pi, plus everything needed to
     * decide whether installing is possible at all.
     */
    fun detect(
        locate: (Boolean) -> dev.pi.agent.process.PiInstallation? = { force -> PiLocator.locate(force) },
        nodePath: () -> String? = { PiLocator.locateNode() },
        npmPath: () -> String? = { PiLocator.locateNpm() },
        versionOf: (String, List<String>) -> String? = ::toolVersion,
    ): JsonObject {
        val install = locate(true)
        val node = nodePath()
        val npm = npmPath()
        val nodeVersion = node?.let { versionOf(it, listOf(it, "-v")) } ?: ""
        val npmVersion = npm?.let { versionOf(it, listOf(it, "-v")) } ?: ""
        val nodeMajor = nodeMajorOf(nodeVersion)

        return buildJsonObject {
            put("ok", true)
            put("node", tool(node, nodeVersion))
            put("npm", tool(npm, npmVersion))
            put("pi", tool(install?.path, install?.version ?: ""))
            put("nodeMajor", nodeMajor)
            put("nodeOk", nodeMajor != null && nodeMajor >= MIN_NODE_MAJOR)
            put("minNodeMajor", MIN_NODE_MAJOR)
            // npm is the install vehicle; without it the only option is a
            // manual path, which the UI must say instead of offering a button
            // that cannot work.
            put("canInstall", npm != null && node != null)
            put("piPackage", PI_PACKAGE)
            put("agentDir", PiCliRunner.agentDir().absolutePath)
            put("customPath", customPiPath() ?: "")
            put("sources", buildJsonArray {
                SOURCES.forEach { (id, registry) ->
                    add(buildJsonObject { put("id", id); put("registry", registry) })
                }
            })
            put("defaultSource", DEFAULT_SOURCE)
            put("needsSetup", install == null)
        }
    }

    /**
     * `npm install -g pi` through [source]. Blocking: npm takes tens of
     * seconds, and the caller (bridge request) is already off the EDT.
     *
     * The located installation is refreshed afterwards so the version shown in
     * the UI comes from the binary that was just installed, never from a guess.
     */
    fun install(
        source: String?,
        npmPath: () -> String? = { PiLocator.locateNpm() },
        nodePath: () -> String? = { PiLocator.locateNode() },
        runner: (ProcessBuilder, Long) -> CliResult = { pb, timeout ->
            PiCliRunner.runProcess(pb, timeout)
        },
        refresh: () -> dev.pi.agent.process.PiInstallation? = {
            PiLocator.locate(forceRefresh = true)
        },
    ): JsonObject {
        val npm = npmPath()
            ?: return error("npm was not found on this machine, so pi cannot be installed automatically")
        val node = nodePath()
        val command = OsProcess.launchCommand(installArgs(npm, source))

        val pb = ProcessBuilder(command).redirectErrorStream(true)
        OsProcess.augmentPathEnv(pb, listOfNotNull(node?.let { File(it).parent }))
        val registry = registryFor(source)
        LOG.info("installing $PI_PACKAGE from $registry via $npm")

        val result = runner(pb, INSTALL_TIMEOUT_SECONDS)
        val output = (result.stdout + "\n" + result.stderr).trim()
        if (!result.success) {
            LOG.warn("pi install failed (exit ${result.exitCode}): $output")
            return buildJsonObject {
                put("ok", false)
                put("exitCode", result.exitCode)
                put("registry", registry)
                put("output", output.take(4000))
                put("error", installFailureHint(result.exitCode, output))
            }
        }

        val installed = refresh()
        LOG.info("pi installed at ${installed?.path ?: "?"} (version ${installed?.version ?: "?"})")
        return buildJsonObject {
            put("ok", installed != null)
            put("exitCode", result.exitCode)
            put("registry", registry)
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

    /** One line the user can act on, on top of the raw npm output. */
    private fun installFailureHint(exitCode: Int, output: String): String {
        val lower = output.lowercase()
        return when {
            lower.contains("eacces") || lower.contains("permission denied") ->
                "npm could not write to its global prefix (permissions). Fix the npm prefix or set pi's path manually."
            lower.contains("etimedout") || lower.contains("enotfound") || lower.contains("econnrefused") ->
                "The registry was unreachable. Try the other source, or install pi yourself and set its path."
            lower.contains("eexist") ->
                "npm refused to overwrite an existing install. Remove it, or set pi's path manually."
            exitCode == -1 ->
                "npm did not finish in time. Check your network or install pi manually and set its path."
            else -> "npm install failed. See the output below; setting pi's path manually always works."
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
}
