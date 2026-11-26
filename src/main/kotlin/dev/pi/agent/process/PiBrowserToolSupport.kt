package dev.pi.agent.process

import com.intellij.openapi.diagnostic.Logger
import dev.pi.agent.ui.LocalUiServer
import java.io.File

/**
 * Installs the bundled pi-browser extension and computes its environment
 * (spec 061 D3). Same per-start extraction pattern as [PiApprovalSupport]:
 * the extension lives in the plugin's resources, is written to the IDE
 * config dir on every pi start so upgrades propagate, and is handed to pi
 * via `--extension <path>` — never installed into `~/.pi/agent/extensions`.
 *
 * The endpoint/token pair is what turns the tool on: without them the
 * extension registers `pi_browser` but every call fails fast with a clear
 * message (pi started from a terminal, or extraction failed).
 */
object PiBrowserToolSupport {
    private val LOG = Logger.getInstance(PiBrowserToolSupport::class.java)

    // No leading slash: PluginClassLoader resolves root-relative paths.
    private const val EXTENSION_RESOURCE = "pi-browser/pi-browser.js"
    private const val EXTENSION_FILE_NAME = "pi-browser.js"

    const val ENV_ENDPOINT = "PI_BROWSER_ENDPOINT"
    const val ENV_TOKEN = "PI_BROWSER_TOKEN"

    /** The `/agent-browser` endpoint on the (already running) UI server. */
    fun endpointFor(server: LocalUiServer): String = server.baseUrl + "agent-browser"

    /**
     * Extracts the bundled extension (overwritten every start so upgrades
     * propagate). Returns the file, or null when extraction failed — pi then
     * runs without the browser tool, everything else unaffected.
     */
    fun ensureExtensionInstalled(): File? {
        return try {
            val dir = PiApprovalSupport.agentDir()
            if (!dir.isDirectory && !dir.mkdirs()) {
                LOG.warn("cannot create pi-agent config dir: $dir")
                return null
            }
            val out = File(dir, EXTENSION_FILE_NAME)
            val resource = PiBrowserToolSupport::class.java.classLoader.getResourceAsStream(EXTENSION_RESOURCE)
            if (resource == null) {
                LOG.warn("pi-browser extension resource missing: $EXTENSION_RESOURCE")
                return null
            }
            resource.use { input -> out.outputStream().use { input.copyTo(it) } }
            out
        } catch (e: Exception) {
            LOG.warn("failed to install pi-browser extension", e)
            return null
        }
    }

    /** D3: the two env vars the pi process needs, applied to [env]. */
    fun applyEnv(env: MutableMap<String, String>, projectToken: String) {
        val server = LocalUiServer.getInstance()
        env[ENV_ENDPOINT] = endpointFor(server)
        env[ENV_TOKEN] = projectToken
    }
}
