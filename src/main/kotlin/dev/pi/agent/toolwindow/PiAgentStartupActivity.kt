package dev.pi.agent.toolwindow

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.wm.ToolWindowManager
import dev.pi.agent.browser.GpuCrashMonitor
import dev.pi.agent.settings.PiAgentSettings

/**
 * Opens the Pi Agent tool window automatically on project start when either
 * the user enabled it in Settings → Tools → Pi Agent, or the IDE was launched
 * with `-Dpi.agent.autoOpen=true` (used by the IDE e2e harness).
 */
class PiAgentStartupActivity : ProjectActivity {

    override suspend fun execute(project: Project) {
        // 052: the GPU crash watch belongs to the IDE, not to the panel — a
        // broken GPU breaks every embedded browser, and the panel may never
        // be opened at all.
        GpuCrashMonitor.getInstance().start()

        val autoOpen = System.getProperty("pi.agent.autoOpen") == "true" ||
            PiAgentSettings.getInstance().autoOpen()
        if (!autoOpen) return
        ApplicationManager.getApplication().invokeLater {
            ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
        }
    }
}
