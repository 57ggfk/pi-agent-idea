package dev.pi.agent.toolwindow

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.wm.ToolWindowManager
import dev.pi.agent.settings.PiAgentSettings

/**
 * Opens the Pi Agent tool window automatically on project start when either
 * the user enabled it in Settings → Tools → Pi Agent, or the IDE was launched
 * with `-Dpi.agent.autoOpen=true` (used by the IDE e2e harness).
 */
class PiAgentStartupActivity : ProjectActivity {

    override suspend fun execute(project: Project) {
        val autoOpen = System.getProperty("pi.agent.autoOpen") == "true" ||
            PiAgentSettings.getInstance().autoOpen()
        if (!autoOpen) return
        ApplicationManager.getApplication().invokeLater {
            ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
        }
    }
}
