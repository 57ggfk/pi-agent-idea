package dev.pi.agent.process

import com.intellij.openapi.diagnostic.Logger
import java.io.File

/**
 * Installs the bundled model-reload extension (spec 016).
 *
 * pi reloads auth.json by itself, but a models.json change made while pi is
 * running only enters the availability snapshot after `ModelRuntime.refresh()`
 * — and RPC mode has no command for it. The extension registers one
 * (`pi-agent-reload-models`) which the bridge triggers through `prompt`, so a
 * saved credential shows up in the model picker without restarting pi and
 * without touching the current session.
 *
 * Loaded with `pi --extension <path>`, next to the approval extension, so only
 * plugin-launched pi processes see it.
 */
object PiModelReload {
    private val LOG = Logger.getInstance(PiModelReload::class.java)

    // No leading slash: PluginClassLoader resolves root-relative paths.
    private const val EXTENSION_RESOURCE = "pi-models/pi-models.js"
    private const val EXTENSION_FILE_NAME = "pi-models.js"

    /**
     * Command the extension registers; also what the bridge sends through
     * `prompt`. Kept in one place so the JS and the Kotlin side cannot drift.
     */
    const val COMMAND = "pi-agent-reload-models"

    /**
     * Extracts the extension into the plugin's config dir, overwriting on every
     * start so upgrades propagate. Returns null when extraction failed — pi then
     * starts without it and the bridge degrades to "re-read the list only".
     */
    fun ensureExtensionInstalled(): File? {
        return try {
            val dir = PiApprovalSupport.agentDir()
            if (!dir.isDirectory && !dir.mkdirs()) {
                LOG.warn("cannot create pi-agent config dir: $dir")
                return null
            }
            val out = File(dir, EXTENSION_FILE_NAME)
            val resource = PiModelReload::class.java.classLoader.getResourceAsStream(EXTENSION_RESOURCE)
            if (resource == null) {
                LOG.warn("pi-models extension resource missing: $EXTENSION_RESOURCE")
                return null
            }
            resource.use { input -> out.outputStream().use { input.copyTo(it) } }
            out
        } catch (e: Exception) {
            LOG.warn("failed to install pi-models extension", e)
            null
        }
    }
}
