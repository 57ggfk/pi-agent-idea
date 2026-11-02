package dev.pi.agent.process

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project

/**
 * Per-project UI preferences that pi does not expose via get_state (unlike
 * autoCompactionEnabled) and therefore must be re-applied by the plugin after
 * the process starts. Backed by the project PropertiesComponent.
 */
@Service(Service.Level.PROJECT)
class PiUserPrefs(private val project: Project) {

    private val properties: PropertiesComponent get() = PropertiesComponent.getInstance(project)

    /** Last chosen auto-retry setting; null until the user toggles it. */
    fun autoRetry(): Boolean? {
        val raw = properties.getValue(KEY_AUTO_RETRY) ?: return null
        return raw == "true"
    }

    fun setAutoRetry(enabled: Boolean) {
        properties.setValue(KEY_AUTO_RETRY, enabled.toString())
    }

    /**
     * Theme preference: "system" (follow the IDE), "light" or "dark".
     * Null until the user makes an explicit choice.
     */
    fun themePreference(): String? {
        val raw = properties.getValue(KEY_THEME) ?: return null
        return raw.takeIf { it == "system" || it == "light" || it == "dark" }
    }

    fun setThemePreference(preference: String) {
        if (preference == "system" || preference == "light" || preference == "dark") {
            properties.setValue(KEY_THEME, preference)
        }
    }

    companion object {
        private const val KEY_AUTO_RETRY = "dev.pi.agent.autoRetry"
        private const val KEY_THEME = "dev.pi.agent.themePreference"

        @JvmStatic
        fun getInstance(project: Project): PiUserPrefs =
            project.getService(PiUserPrefs::class.java)
    }
}
