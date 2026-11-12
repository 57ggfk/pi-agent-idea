package dev.pi.agent.process

import com.intellij.openapi.diagnostic.Logger
import java.io.File

/**
 * Installs the bundled IDE-env extension (spec 032).
 *
 * The extension appends the IDE environment snapshot to pi's system prompt on
 * every agent start (before_agent_start), reading the snapshot file whose path
 * arrives through `PI_IDE_ENV_SNAPSHOT` — so an SDK change reaches pi on the
 * next message, without restarting it. Loaded with `pi --extension <path>`,
 * next to the approval and model-reload extensions, so only plugin-launched pi
 * processes are affected. Extraction failures degrade: pi runs without the
 * extension and the prompt stays exactly as before (FR-001/FR-010).
 */
object PiIdeEnvExtension {
    private val LOG = Logger.getInstance(PiIdeEnvExtension::class.java)

    // No leading slash: PluginClassLoader resolves root-relative paths.
    private const val EXTENSION_RESOURCE = "pi-env/pi-env.js"
    private const val EXTENSION_FILE_NAME = "pi-env.js"

    /**
     * Extracts the extension into the plugin's config dir, overwriting on every
     * start so upgrades propagate. Returns null when extraction failed — pi then
     * starts without it and the snapshot flag stays unused (FR-010).
     */
    fun ensureExtensionInstalled(): File? {
        return try {
            val dir = PiApprovalSupport.agentDir()
            if (!dir.isDirectory && !dir.mkdirs()) {
                LOG.warn("cannot create pi-agent config dir: $dir")
                return null
            }
            val out = File(dir, EXTENSION_FILE_NAME)
            val resource = PiIdeEnvExtension::class.java.classLoader.getResourceAsStream(EXTENSION_RESOURCE)
            if (resource == null) {
                LOG.warn("pi-env extension resource missing: $EXTENSION_RESOURCE")
                return null
            }
            resource.use { input -> out.outputStream().use { input.copyTo(it) } }
            out
        } catch (e: Exception) {
            LOG.warn("failed to install pi-env extension", e)
            null
        }
    }
}
