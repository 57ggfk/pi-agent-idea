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

    /**
     * UI language preference (spec 008 FR-001): "system" (follow the IDE) or a
     * registered language code. The value passes through unvalidated on read —
     * the frontend owns the registry and corrects unknown leftovers itself.
     */
    fun languagePreference(): String? = properties.getValue(KEY_LANGUAGE)

    fun setLanguagePreference(value: String) {
        properties.setValue(KEY_LANGUAGE, value)
    }

    /**
     * Explicit npm registry for package metadata and installs (spec 033
     * FR-016): null means "follow npm's own configuration" — no override is
     * passed anywhere. A URL here is validated by the caller
     * ([dev.pi.agent.manage.PiEnvironment.normalizeCustomRegistry]) before it
     * is stored; installs then carry it to npm as `NPM_CONFIG_REGISTRY`.
     */
    fun registryOverride(): String? = properties.getValue(KEY_REGISTRY_OVERRIDE)

    fun setRegistryOverride(value: String?) {
        if (value.isNullOrBlank()) {
            properties.unsetValue(KEY_REGISTRY_OVERRIDE)
        } else {
            properties.setValue(KEY_REGISTRY_OVERRIDE, value)
        }
    }

    companion object {
        private const val KEY_AUTO_RETRY = "dev.pi.agent.autoRetry"
        private const val KEY_THEME = "dev.pi.agent.themePreference"
        private const val KEY_LANGUAGE = "dev.pi.agent.languagePreference"
        private const val KEY_REGISTRY_OVERRIDE = "dev.pi.agent.registryOverride"

        @JvmStatic
        fun getInstance(project: Project): PiUserPrefs =
            project.getService(PiUserPrefs::class.java)
    }
}
