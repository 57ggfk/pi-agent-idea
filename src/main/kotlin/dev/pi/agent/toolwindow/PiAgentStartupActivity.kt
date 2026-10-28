package dev.pi.agent.toolwindow

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.wm.ToolWindowManager

/**
 * Opens the Pi Agent tool window automatically when launched with
 * `-Dpi.agent.autoOpen=true` (used by the IDE e2e harness).
 */
class PiAgentStartupActivity : ProjectActivity {

    override suspend fun execute(project: Project) {
        if (System.getProperty("pi.agent.autoOpen") != "true") return
        ApplicationManager.getApplication().invokeLater {
            ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
        }
    }
}
