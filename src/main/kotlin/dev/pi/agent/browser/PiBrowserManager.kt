package dev.pi.agent.browser

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory
import dev.pi.agent.PiAgentBundle

/**
 * Project-level entry point for the browser tab (spec 048 T009). Owns the
 * "one browser Content per project" rule: [open] reuses the existing tab or
 * lazily builds one, selects it, and navigates.
 *
 * The browser Content deliberately stays OUTSIDE `PiProcessManager` (spec
 * US8): no pi instance id, no event bucket, no pi process — 019's instance
 * registry and the chat tab counting are untouched by this class.
 */
@Service(Service.Level.PROJECT)
class PiBrowserManager(private val project: Project) {

    /** Opens (or refocuses) the browser tab and navigates to [url]. */
    fun open(url: String) {
        if (ApplicationManager.getApplication().isDispatchThread) {
            doOpen(url)
        } else {
            ApplicationManager.getApplication().invokeLater { doOpen(url) }
        }
    }

    private fun doOpen(url: String) {
        if (project.isDisposed) return
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOLWINDOW_ID) ?: return
        toolWindow.show(null)
        val manager = toolWindow.contentManager
        val existing = manager.contents.firstOrNull { it.getComponent() is BrowserPanel }
        if (existing != null) {
            manager.setSelectedContent(existing)
            (existing.getComponent() as BrowserPanel).load(url)
            return
        }
        val panel = BrowserPanel(project)
        val content = ContentFactory.getInstance().createContent(
            panel, PiAgentBundle.message("toolwindow.browser.tab"), true,
        )
        content.isCloseable = true
        // Content dispose (tab closed) releases the panel, which releases the
        // kernel's JCEF browser — no leak, no confirm needed (no pi run here).
        Disposer.register(content, panel)
        manager.addContent(content)
        manager.setSelectedContent(content)
        panel.load(url)
    }

    /**
     * 049: the project's tool-window browser panel, or null when the tab has
     * never been opened (or cannot exist). The agent endpoint resolves the
     * kernel through this — the editor carrier is deliberately unreachable
     * from the agent (plan D8).
     */
    fun browserPanel(): BrowserPanel? {
        if (project.isDisposed) return null
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOLWINDOW_ID) ?: return null
        return toolWindow.contentManager.contents
            .firstOrNull { it.getComponent() is BrowserPanel }
            ?.getComponent() as? BrowserPanel
    }

    companion object {
        private const val TOOLWINDOW_ID = "Pi Agent"

        @JvmStatic
        fun getInstance(project: Project): PiBrowserManager =
            project.getService(PiBrowserManager::class.java)
    }
}
