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
 * browser Contents: [open] reuses the tab that already shows [url] (F-208
 * multi-tab MVP — up to [MAX_TABS] Contents, aligned with 019's instance
 * cap; each Content owns its own kernel, so the P-7 one-windowed-browser-per-
 * kernel rule holds), falls back to the selected tab when at the ceiling, and
 * otherwise lazily builds a new tab, selects it, and navigates.
 *
 * The browser Content deliberately stays OUTSIDE `PiProcessManager` (spec
 * US8): no pi instance id, no event bucket, no pi process — 019's instance
 * registry and the chat tab counting are untouched by this class.
 */
@Service(Service.Level.PROJECT)
class PiBrowserManager(private val project: Project) {

    /**
     * Opens (or refocuses) a browser tab, navigates to [url], and returns the
     * exact [BrowserPanel] it landed on. F-208 round 2: the agent endpoint
     * needs THAT panel (invokeAndWait on the caller thread, so there is no
     * selection-lag race where the previously selected tab would be navigated
     * as well); fire-and-forget callers simply ignore the return.
     */
    fun open(url: String): BrowserPanel? {
        return if (ApplicationManager.getApplication().isDispatchThread) {
            doOpen(url)
        } else {
            var result: BrowserPanel? = null
            runCatching {
                ApplicationManager.getApplication().invokeAndWait(
                    Runnable { result = doOpen(url) },
                )
            }
            result
        }
    }

    private fun doOpen(url: String): BrowserPanel? {
        if (project.isDisposed) return null
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOLWINDOW_ID) ?: return null
        toolWindow.show(null)
        val manager = toolWindow.contentManager
        val browserContents = manager.contents.filter { it.getComponent() is BrowserPanel }
        val existing = browserContents.firstOrNull { (it.getComponent() as BrowserPanel).currentUrl() == url }
        if (existing != null) {
            manager.setSelectedContent(existing)
            val panel = existing.getComponent() as BrowserPanel
            panel.load(url)
            return panel
        }
        if (browserContents.size >= MAX_TABS) {
            // F-208 ceiling: reuse the tab the user is looking at (or the
            // first browser tab) instead of growing Contents without bound.
            val fallback = browserContents.firstOrNull { it.isSelected } ?: browserContents.first()
            manager.setSelectedContent(fallback)
            val panel = fallback.getComponent() as BrowserPanel
            panel.load(url)
            return panel
        }
        ensureTabListener(manager)
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
        return panel
    }

    /**
     * 049: the project's tool-window browser panel, or null when no browser
     * tab exists. The agent endpoint resolves the kernel through this — the
     * editor carrier is deliberately unreachable from the agent (plan D8).
     * With several tabs (F-208) the agent targets the SELECTED one.
     */
    fun browserPanel(): BrowserPanel? {
        if (project.isDisposed) return null
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOLWINDOW_ID) ?: return null
        val browserContents = toolWindow.contentManager.contents.filter { it.getComponent() is BrowserPanel }
        return (browserContents.firstOrNull { it.isSelected } ?: browserContents.firstOrNull())
            ?.getComponent() as? BrowserPanel
    }

    /**
     * F-103 round 2: switching browser tabs must re-sync each panel's echo row
     * from ITS OWN kernel — the walkthrough caught a tab showing another tab's
     * URL after re-selection (echo rows only update from kernel callbacks that
     * fired while the tab was selected). One listener per content manager.
     */
    private fun ensureTabListener(manager: com.intellij.ui.content.ContentManager) {
        if (tabListenerAdded) return
        tabListenerAdded = true
        manager.addContentManagerListener(object : com.intellij.ui.content.ContentManagerListener {
            override fun selectionChanged(event: com.intellij.ui.content.ContentManagerEvent) {
                (event.content.getComponent() as? BrowserPanel)?.refreshFromKernel()
            }
        })
    }

    companion object {
        private const val TOOLWINDOW_ID = "Pi Agent"

        private var tabListenerAdded = false

        /** F-208: same per-project ceiling as the chat instance tabs (019). */
        const val MAX_TABS = 4

        @JvmStatic
        fun getInstance(project: Project): PiBrowserManager =
            project.getService(PiBrowserManager::class.java)
    }
}
