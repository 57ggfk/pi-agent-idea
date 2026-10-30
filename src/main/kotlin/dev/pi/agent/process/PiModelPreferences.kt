package dev.pi.agent.process

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project

/**
 * Remembers the user's last selected model per project so the pi process
 * starts on it (`--provider X --model Y`).
 */
@Service(Service.Level.PROJECT)
class PiModelPreferences(private val project: Project) {

    private val properties: PropertiesComponent get() = PropertiesComponent.getInstance(project)

    fun get(): Pair<String, String>? {
        val provider = properties.getValue(PROVIDER_KEY) ?: return null
        val model = properties.getValue(MODEL_KEY) ?: return null
        if (provider.isBlank() || model.isBlank()) return null
        return provider to model
    }

    fun set(provider: String, model: String) {
        properties.setValue(PROVIDER_KEY, provider)
        properties.setValue(MODEL_KEY, model)
    }

    companion object {
        private const val PROVIDER_KEY = "dev.pi.agent.lastProvider"
        private const val MODEL_KEY = "dev.pi.agent.lastModel"

        @JvmStatic
        fun getInstance(project: Project): PiModelPreferences =
            project.getService(PiModelPreferences::class.java)
    }
}
