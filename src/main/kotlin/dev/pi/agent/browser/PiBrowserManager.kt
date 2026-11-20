package dev.pi.agent.browser

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
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

    /** 056: per-instance monotonic tab-id sequence (t1/e2/t3 …, never reused). */
    private val tabIds = BrowserTabIdSequence()

    /**
     * Opens (or refocuses) a browser tab, navigates to [url], and returns the
     * exact [BrowserPanel] it landed on. F-208 round 2: the agent endpoint
     * needs THAT panel (invokeAndWait on the caller thread, so there is no
     * selection-lag race where the previously selected tab would be navigated
     * as well); fire-and-forget callers simply ignore the return.
     */
    fun open(url: String): BrowserPanel? = open(url, BrowserCarrier.TOOLWINDOW)

    /**
     * 054 agent dual-form (user-directed): opens [url] in the requested
     * carrier — the tool-window tab (the 048 default) or the editor-form
     * preview — and returns the exact [BrowserPanel] it landed on. Records
     * [lastAgentCarrier] so the agent's target-less follow-ups (read/scroll/
     * console) reach the same panel even after the user moves the selection.
     */
    fun open(url: String, carrier: BrowserCarrier): BrowserPanel? {
        val panel = if (ApplicationManager.getApplication().isDispatchThread) {
            doOpen(url, carrier)
        } else {
            var result: BrowserPanel? = null
            runCatching {
                ApplicationManager.getApplication().invokeAndWait(
                    Runnable { result = doOpen(url, carrier) },
                )
            }
            result
        }
        if (panel != null) {
            lastAgentCarrier = carrier
            // 056: the landing panel's IDENTITY — follow-ups without an
            // explicit tab address this panel even after the user selects a
            // different tab.
            lastTabId = tabIdOf(panel)
        }
        return panel
    }

    private fun doOpen(url: String, carrier: BrowserCarrier): BrowserPanel? = when (carrier) {
        BrowserCarrier.TOOLWINDOW -> doOpenToolWindow(url)
        BrowserCarrier.EDITOR -> doOpenEditor(url)
    }

    private fun doOpenToolWindow(url: String): BrowserPanel? {
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
        val panel = createTab(manager)
        panel.load(url)
        return panel
    }

    /**
     * 054: opens a NEW browser tab WITHOUT navigating — the placeholder shows
     * until the user (or the agent) types an address. Used by the tool
     * window's "New browser tab" header button. EDT call.
     */
    fun newTab() {
        if (project.isDisposed) return
        if (!ApplicationManager.getApplication().isDispatchThread) {
            ApplicationManager.getApplication().invokeLater { newTab() }
            return
        }
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOLWINDOW_ID) ?: return
        toolWindow.show(null)
        val manager = toolWindow.contentManager
        if (manager.contents.count { it.getComponent() is BrowserPanel } >= MAX_TABS) return
        createTab(manager)
    }

    /**
     * Creates and selects a fresh browser tab (no navigation). 048 P-7 hard
     * rule (round 2 enforcement): ONE windowed browser per tool window — the
     * walkthrough's multi-tab build created one per TAB, and the hidden tabs'
     * native HWNDs stacked over the visible page and ate every click (the
     * F-202/F-110 re-verify's dead page interaction). Tab 1 keeps windowed;
     * tabs 2+ are OSR (editor-carrier proven).
     */
    private fun createTab(manager: com.intellij.ui.content.ContentManager): BrowserPanel {
        ensureTabListener(manager)
        val offscreen = windowedTabCreated
        windowedTabCreated = true
        val panel = BrowserPanel(project, offscreen)
        val content = ContentFactory.getInstance().createContent(
            panel, PiAgentBundle.message("toolwindow.browser.tab"), true,
        )
        content.isCloseable = true
        // 056: the tab id is minted at CREATION and lives in the Content's
        // userData — stable for the Content's lifetime, gone when the tab
        // closes, never reused (per-manager monotonic sequence).
        content.putUserData(TAB_ID_KEY, tabIds.next(BrowserCarrier.TOOLWINDOW))
        // Content dispose (tab closed) releases the panel, which releases the
        // kernel's JCEF browser — no leak, no confirm needed (no pi run here).
        Disposer.register(content, panel)
        manager.addContent(content)
        manager.setSelectedContent(content)
        return panel
    }

    /**
     * 049: the project's tool-window browser panel, or null when no browser
     * tab exists. 054 agent dual-form: the agent can now also reach the
     * editor carrier ([agentPanel]) — this stays the tool-window half of that
     * resolver. With several tabs (F-208) the agent targets the SELECTED one.
     */
    fun browserPanel(): BrowserPanel? {
        if (project.isDisposed) return null
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOLWINDOW_ID) ?: return null
        val browserContents = toolWindow.contentManager.contents.filter { it.getComponent() is BrowserPanel }
        return (browserContents.firstOrNull { it.isSelected } ?: browserContents.firstOrNull())
            ?.getComponent() as? BrowserPanel
    }

    /**
     * 054 agent dual-form: opens [url] in the EDITOR-form carrier (a pi
     * preview editor tab). Reuses an already-open preview tab showing [url]
     * (F-208 parity — no tab pile-up), otherwise opens one via
     * [PiBrowserEditorProvider.openUrlInEditor]. Returns that panel so the
     * agent's open answer carries the editor kernel's snapshot.
     */
    private fun doOpenEditor(url: String): BrowserPanel? {
        if (project.isDisposed) return null
        val editorManager = FileEditorManager.getInstance(project)
        var file = editorManager.openFiles.firstOrNull {
            PiBrowserPreviewFiles.isPreview(it) && PiBrowserPreviewFiles.urlOf(it) == url
        }
        if (file == null) {
            if (!PiBrowserEditorProvider.openUrlInEditor(project, url, null)) return null
            file = editorManager.openFiles.firstOrNull {
                PiBrowserPreviewFiles.isPreview(it) && PiBrowserPreviewFiles.urlOf(it) == url
            } ?: return null
        } else {
            editorManager.openFile(file, true)
        }
        return (editorManager.getEditors(file)
            .firstOrNull { it is PiBrowserFileEditor } as? PiBrowserFileEditor)?.agentPanel()
    }

    /** The selected editor-form panel, or null when no preview tab is selected. */
    private fun editorCarrierPanel(): BrowserPanel? =
        (FileEditorManager.getInstance(project).selectedEditor as? PiBrowserFileEditor)?.agentPanel()

    /**
     * 054 agent dual-form: the agent's panel for [carrier] — the tool-window
     * selected tab, or the selected editor-form preview. Null when that
     * carrier has no live panel (no browser tab yet, or the preview closed).
     */
    fun agentPanel(carrier: BrowserCarrier): BrowserPanel? = when (carrier) {
        BrowserCarrier.TOOLWINDOW -> browserPanel()
        BrowserCarrier.EDITOR -> editorCarrierPanel()
    }

    // ---- 056 页签寻址: stable per-panel ids + identity tracking ----

    /**
     * Scans the LIVE browser panels — tool-window contents plus open editor
     * previews — stamping ids where a panel has none (editor previews can be
     * created by user paths the manager doesn't route through; the scan
     * lazily mints their id on first sight). Deliberately NO resident
     * registry: closed tabs simply drop out of the next scan, so no stale
     * entry can answer an old address.
     *
     * Threading follows the existing off-EDT reads of the tool window
     * (browserPanel() does the same from the agent endpoint thread).
     */
    internal fun liveTabs(): List<BrowserTabRef> {
        if (project.isDisposed) return emptyList()
        val tabs = mutableListOf<BrowserTabRef>()
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOLWINDOW_ID)
        if (toolWindow != null) {
            for (content in toolWindow.contentManager.contents) {
                val panel = content.getComponent() as? BrowserPanel ?: continue
                val id = content.getUserData(TAB_ID_KEY)
                    ?: tabIds.next(BrowserCarrier.TOOLWINDOW).also { content.putUserData(TAB_ID_KEY, it) }
                tabs += BrowserTabRef(id, panel, BrowserCarrier.TOOLWINDOW, content.isSelected)
            }
        }
        val editorManager = FileEditorManager.getInstance(project)
        for (file in editorManager.openFiles) {
            if (!PiBrowserPreviewFiles.isPreview(file)) continue
            val editor = editorManager.getEditors(file)
                .firstOrNull { it is PiBrowserFileEditor } as? PiBrowserFileEditor ?: continue
            val id = file.getUserData(TAB_ID_KEY)
                ?: tabIds.next(BrowserCarrier.EDITOR).also { file.putUserData(TAB_ID_KEY, it) }
            tabs += BrowserTabRef(id, editor.agentPanel(), BrowserCarrier.EDITOR, editorManager.selectedEditor == editor)
        }
        return tabs
    }

    /**
     * 056: the live panel addressed by [tabId], or null — the caller answers
     * the model-readable miss ("no browser tab t9"). Ids are never reused, so
     * a closed tab's address stays a miss instead of silently hitting a
     * recycled panel.
     */
    fun panelById(tabId: String): BrowserPanel? = liveTabs().firstOrNull { it.tabId == tabId }?.panel

    /** 056: the id of [panel] among the live tabs; null when it is not live (responses omit "tab"). */
    fun tabIdOf(panel: BrowserPanel): String? = liveTabs().firstOrNull { it.panel === panel }?.tabId

    /** 056 LIST: every live browser panel as `{tab,url,title,carrier,selected}`. */
    fun listTabs(): List<BrowserTabSummary> = liveTabs().map { it.toSummary() }

    /**
     * 056: the tab id the agent's last open landed on (explicit-tab opens
     * record themselves via [recordLastTabId]). Resolution order: explicit
     * tab param → this → the 055 carrier fallback.
     */
    @Volatile
    var lastTabId: String? = null
        private set

    internal fun recordLastTabId(id: String?) {
        lastTabId = id
    }

    /**
     * 054 agent dual-form: the carrier the AGENT last opened into. Explicit
     * `target` params override it; target-less follow-ups (read/scroll/
     * console) resolve here so they reach the panel the open landed on.
     */
    @Volatile
    var lastAgentCarrier: BrowserCarrier = BrowserCarrier.TOOLWINDOW
        private set

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

        /** P-7: whether this project's tool window already has its one windowed browser tab. */
        private var windowedTabCreated = false

        /**
         * 056: where a tool-window tab's agent-facing id lives. Editor
         * previews keep theirs on the LightVirtualFile's userData (same key).
         */
        private val TAB_ID_KEY = Key.create<String>("pi.browser.tab.id")

        /** F-208: same per-project ceiling as the chat instance tabs (019). */
        const val MAX_TABS = 4

        @JvmStatic
        fun getInstance(project: Project): PiBrowserManager =
            project.getService(PiBrowserManager::class.java)
    }
}
