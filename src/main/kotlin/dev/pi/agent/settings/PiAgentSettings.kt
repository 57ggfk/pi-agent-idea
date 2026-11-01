package dev.pi.agent.settings

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project

/**
 * Plugin-level user settings (Settings → Tools → Pi Agent).
 *
 * Follows the repo's lightweight [PropertiesComponent] persistence style
 * (see PiModelPreferences): two keys on the application level, so they apply
 * to every project.
 *
 * - `piPath`: explicit pi executable. Empty/unset = auto-discovery via
 *   [dev.pi.agent.process.PiLocator]. This is the supported escape hatch for
 *   machines where discovery fails (GUI-launched IDEs, Windows installs pi
 *   can't see) — the docs-promised "custom pi path" setting.
 * - `autoOpen`: open the Pi Agent tool window automatically at project start.
 */
@Service(Service.Level.APP)
class PiAgentSettings private constructor() {

    private val properties: PropertiesComponent get() = PropertiesComponent.getInstance()

    /** Explicit pi executable path, or null when discovery should be used. */
    fun customPiPath(): String? =
        properties.getValue(PI_PATH_KEY)?.takeIf { it.isNotBlank() }

    fun setCustomPiPath(path: String?) {
        if (path.isNullOrBlank()) {
            properties.unsetValue(PI_PATH_KEY)
        } else {
            properties.setValue(PI_PATH_KEY, path.trim())
        }
    }

    fun autoOpen(): Boolean = properties.getBoolean(AUTO_OPEN_KEY, false)

    fun setAutoOpen(value: Boolean) {
        properties.setValue(AUTO_OPEN_KEY, value, false)
    }

    companion object {
        private const val PI_PATH_KEY = "dev.pi.agent.piPath"
        private const val AUTO_OPEN_KEY = "dev.pi.agent.autoOpen"

        @JvmStatic
        fun getInstance(): PiAgentSettings = ApplicationManager.getApplication()
            .getService(PiAgentSettings::class.java)

        /** Restarts pi in every open project (used after a settings change). */
        @JvmStatic
        fun restartPiEverywhere() {
            for (project in com.intellij.openapi.project.ProjectManager.getInstance().openProjects) {
                if (project.isDisposed) continue
                try {
                    dev.pi.agent.process.PiProcessManager.getInstance(project).restart()
                } catch (_: Exception) {
                    // Project may not be ready; pi will start on demand.
                }
            }
        }
    }
}
