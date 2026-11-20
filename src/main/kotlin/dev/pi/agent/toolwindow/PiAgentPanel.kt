package dev.pi.agent.toolwindow

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import dev.pi.agent.PiAgentBundle
import dev.pi.agent.bridge.BridgeService
import dev.pi.agent.bridge.DropPaths
import dev.pi.agent.bridge.DropRefs
import dev.pi.agent.bridge.DropSource
import dev.pi.agent.browser.LinkOption
import dev.pi.agent.browser.LinkRoute
import dev.pi.agent.browser.LinkRouting
import dev.pi.agent.browser.PiBrowserHandlers
import dev.pi.agent.browser.PiBrowserManager
import dev.pi.agent.browser.PiDownloader
import dev.pi.agent.browser.JcefBrowserZoom
import dev.pi.agent.browser.JcefLogLevelGuard
import dev.pi.agent.process.PiProcessManager
import dev.pi.agent.settings.PiAgentSettings
import dev.pi.agent.ui.LocalUiServer
import dev.pi.agent.ui.PiUiErrorPanel
import org.cef.CefSettings
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefContextMenuParams
import org.cef.callback.CefDragData
import org.cef.callback.CefMenuModel
import org.cef.handler.CefContextMenuHandlerAdapter
import org.cef.handler.CefDisplayHandlerAdapter
import org.cef.handler.CefDragHandler
import org.cef.handler.CefKeyboardHandler
import org.cef.handler.CefKeyboardHandlerAdapter
import org.cef.handler.CefLifeSpanHandlerAdapter
import org.cef.handler.CefLoadHandler
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.BorderLayout
import java.awt.MouseInfo
import java.awt.datatransfer.StringSelection
import java.awt.datatransfer.Transferable
import java.awt.dnd.DropTarget
import java.awt.dnd.DropTargetAdapter
import java.awt.dnd.DropTargetDragEvent
import java.awt.dnd.DropTargetDropEvent
import java.awt.dnd.DropTargetEvent
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import javax.swing.BorderFactory
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea
import javax.swing.SwingUtilities
import javax.swing.Timer

/**
 * Hosts the web UI. The bridge transport is HTTP (loopback, see LocalUiServer),
 * so the panel only needs to point a JCEF browser at the UI server.
 *
 * Navigations away from the UI server (markdown links) are handed to the
 * system browser so they can never hijack the SPA.
 *
 * Every step that can fail — JCEF unavailable, the loopback server refusing to
 * start, the page failing to navigate — ends on a [PiUiErrorPanel] that names
 * the failure and carries the load URL, because the alternative (what shipped
 * up to 0.5.1) is a white rectangle with no information in it at all.
 */
class PiAgentPanel(private val project: Project, private val instanceId: Int = 1) : JPanel(), Disposable {

    /** Java factory/content listeners use this stable tab identity. */
    val id: Int get() = instanceId

    private val log = Logger.getInstance(PiAgentPanel::class.java)

    private var browser: JBCefBrowser? = null
    private var disposed = false

    /** When the current document was loaded; the silence check counts from here. */
    private var mountedAt = System.currentTimeMillis()

    /**
     * Watches the renderer from the outside. Nothing in Swing can tell that
     * the Chromium process is gone or wedged: OSR keeps repainting the last
     * frame, so the panel looks healthy while every click goes nowhere. That
     * is exactly what "it sat there for hours and then froze" looked like on a
     * real machine — the browser process had died, the picture had not.
     *
     * The one reliable signal is the frontend's own long-poll: the SPA polls
     * /bridge/poll every 20s for the whole life of the page, whatever tab is
     * shown. If that stops while the panel is on screen, the page is not
     * running and rebuilding the browser is the only recovery.
     *
     * A plain Swing timer, not Alarm: the panel only needs "on the EDT, every
     * N seconds", and this compiles unchanged across the whole 233–263 range
     * (Alarm's Request type is private in some of those builds).
     */
    private val healthWatch = Timer(HEALTH_CHECK_INTERVAL_MS.toInt()) { checkBridgeSilence() }

    private val linkHandler = object : CefRequestHandlerAdapter() {
        override fun onBeforeBrowse(
            browser: CefBrowser?,
            frame: CefFrame?,
            request: CefRequest?,
            isRedirect: Boolean,
            hasDevTools: Boolean,
        ): Boolean {
            val url = request?.url ?: return false
            return routeExternal(url)
        }
    }

    /**
     * The chat SPA's own origin (`http://127.0.0.1:<port>`), for origin-exact
     * link routing: the SPA stays in the chat browser, but OTHER loopback
     * origins — the AI's dev servers, preview routes — are real links and
     * route by the setting (049 真机：host-only loopback 检查曾让它们的
     * target=_blank popup 裸开成白窗)。
     */
    private fun ownOrigin(): String? = try {
        LocalUiServer.getInstance().baseUrl.dropLast(1)
    } catch (t: Throwable) {
        null
    }

    /**
     * 048 (spec US4): where chat links go, per the three-state setting.
     * SYSTEM (default) keeps the 037 semantics byte-for-byte; EMBEDDED hands
     * the URL to the in-app browser tab; ASK shows the 049 selector (spec
     * US1) — a three-row popup the user picks a destination from. The pure
     * decision lives in [LinkRouting.routeExternalLink] (unit-tested, origin-
     * aware overload per F-107); this wrapper only executes the IDE-side actions.
     */
    private fun routeExternal(url: String): Boolean {
        val decision = LinkRouting.routeExternalLink(url, PiAgentSettings.getInstance().linkTarget(), ownOrigin())
        return when (decision) {
            is LinkRoute.CefDefault -> false // SPA navigation / blank
            is LinkRoute.SystemBrowser -> {
                BrowserUtil.browse(url)
                true
            }
            is LinkRoute.Embedded -> {
                PiBrowserManager.getInstance(project).open(url)
                true
            }
            is LinkRoute.AskUser -> {
                // CEF navigation is cancelled right away; the selector decides
                // the destination on the EDT (the click arrives on a CEF
                // thread and popups must be shown there).
                ApplicationManager.getApplication().invokeLater { showLinkSelector(url) }
                true
            }
        }
    }

    /**
     * F-211 (corrected F-107): right-click on a chat link APPENDS the three
     * destination items after a separator instead of clearing the model —
     * the 049 build wiped the native menu (open in new tab / copy link
     * address / save image disappeared). Foreign command ids return false so
     * CEF keeps handling its own items.
     */
    private val contextMenuHandler = object : CefContextMenuHandlerAdapter() {
        override fun onBeforeContextMenu(
            browser: CefBrowser?,
            frame: CefFrame?,
            params: CefContextMenuParams?,
            model: CefMenuModel?,
        ) {
            val url = params?.linkUrl ?: return
            if (url.isBlank()) return
            val m = model ?: return
            m.addSeparator()
            // 058：与浏览器面板链接菜单同款四项同款顺序——两个 Pi 目的地相邻，
            // copy 收尾；ASK 选择器（LinkRouting.linkOptions）三行不动。
            m.addItem(PiBrowserHandlers.MENU_ID_OPEN_SYSTEM, PiAgentBundle.message("browser.link.option.SYSTEM_BROWSER"))
            m.addItem(PiBrowserHandlers.MENU_ID_OPEN_EMBEDDED, PiAgentBundle.message("browser.link.option.EMBEDDED"))
            m.addItem(PiBrowserHandlers.MENU_ID_OPEN_PI_EDITOR, PiAgentBundle.message("browser.link.option.PI_EDITOR"))
            m.addItem(PiBrowserHandlers.MENU_ID_COPY_LINK, PiAgentBundle.message("browser.link.option.COPY"))
        }

        override fun onContextMenuCommand(
            browser: CefBrowser?,
            frame: CefFrame?,
            params: CefContextMenuParams?,
            commandId: Int,
            eventFlags: Int,
        ): Boolean {
            val url = params?.linkUrl
            if (url.isNullOrBlank()) return false
            when (commandId) {
                PiBrowserHandlers.MENU_ID_OPEN_SYSTEM -> BrowserUtil.browse(url)
                PiBrowserHandlers.MENU_ID_OPEN_EMBEDDED -> PiBrowserManager.getInstance(project).open(url)
                PiBrowserHandlers.MENU_ID_COPY_LINK -> ApplicationManager.getApplication().invokeLater {
                    CopyPasteManager.getInstance().setContents(StringSelection(url))
                }
                // 058: 同浏览器面板第 4 项——编辑器形态新页签，EDT hop
                //（CEF 回调线程不得触碰 FileEditorManager）。
                PiBrowserHandlers.MENU_ID_OPEN_PI_EDITOR -> ApplicationManager.getApplication().invokeLater {
                    dev.pi.agent.browser.PiBrowserEditorProvider.openUrlInEditor(project, url, null)
                }
                else -> return false // native items -> CEF
            }
            return true
        }
    }

    /**
     * 049 US1: ask-mode selector. Three rows in the spec Q3 order (system
     * browser / Pi browser / copy), Esc or an outside click opens nothing.
     * The raw URL rides along as the popup's ad text so the user always sees
     * exactly what is about to open.
     */
    private fun showLinkSelector(url: String) {
        val icons = mapOf(
            LinkOption.SYSTEM_BROWSER to AllIcons.Actions.MoveToTopRight,
            LinkOption.EMBEDDED to AllIcons.General.Web,
            LinkOption.COPY to AllIcons.Actions.Copy,
        )
        val renderer = object : SimpleListCellRenderer<LinkOption>() {
            override fun customize(
                list: javax.swing.JList<out LinkOption>,
                value: LinkOption,
                index: Int,
                selected: Boolean,
                hasFocus: Boolean,
            ) {
                icon = icons[value]
                text = value.label()
            }
        }
        val popup = JBPopupFactory.getInstance()
            .createPopupChooserBuilder(LinkRouting.linkOptions())
            .setTitle(PiAgentBundle.message("browser.link.selector.title"))
            .setRenderer(renderer)
            .setAdText(url)
            .setItemChosenCallback { option ->
                when (option) {
                    LinkOption.SYSTEM_BROWSER -> BrowserUtil.browse(url)
                    LinkOption.EMBEDDED -> PiBrowserManager.getInstance(project).open(url)
                    LinkOption.COPY -> CopyPasteManager.getInstance().setContents(StringSelection(url))
                }
            }
            .createPopup()
        val at = MouseInfo.getPointerInfo()?.location
        if (at != null) {
            popup.show(RelativePoint(at))
        } else {
            popup.showInFocusCenter()
        }
    }

    /**
     * F-205: Ctrl +/-/0 zooms the chat page itself, via the shared CEF
     * keyboard helper (no platform zoom API exists; the accelerator lives in
     * Chrome's UI layer, so hosts implement it).
     */
    private val keyboardHandler = object : CefKeyboardHandlerAdapter() {
        override fun onPreKeyEvent(
            browser: CefBrowser,
            event: CefKeyboardHandler.CefKeyEvent,
            isKeyboardShortcut: org.cef.misc.BoolRef?,
        ): Boolean = JcefBrowserZoom.onPreKeyEvent(browser, event)
    }

    /**
     * F-213 (defensive): the chat panel never registered a download handler,
     * so a download click in the chat silently cancelled (CEF's no-handler
     * default). On non-OOP IDEs this registration makes chat downloads land
     * in ~/Downloads with the reveal notification; under OOP the platform
     * never fires the callback (F-213) — that layer is IDE-side, not ours.
     */
    private val downloadHandler = PiBrowserHandlers.createDownloadHandler(
        onStart = null,
        onDone = { ok, path ->
            if (ok) PiDownloader.notifyDone(project, path)
            else PiDownloader.notifyFailure(project, path)
        },
        onProgress = null,
    )

    /**
     * `target="_blank"` links (marketplace npm/repo cards) open a popup browser
     * before any navigation happens, so [linkHandler] alone cancels the
     * navigation and leaves an empty white window behind. Catching the popup
     * itself routes the target URL to the system browser and cancels the
     * popup — no white window, same channel as every other external link.
     */
    private val popupHandler = object : CefLifeSpanHandlerAdapter() {
        override fun onBeforePopup(
            browser: CefBrowser?,
            frame: CefFrame?,
            targetUrl: String?,
            frameName: String?,
        ): Boolean {
            val url = targetUrl ?: return false
            return routeExternal(url)
        }
    }

    /**
     * Navigation failures are invisible otherwise: JCEF renders an empty
     * document and the panel keeps the white background it was born with.
     */
    private val loadHandler = object : CefLoadHandlerAdapter() {
        override fun onLoadError(
            browser: CefBrowser?,
            frame: CefFrame?,
            errorCode: CefLoadHandler.ErrorCode?,
            errorText: String?,
            failedUrl: String?,
        ) {
            // Sub-frames and intentional aborts (the SPA replacing its own
            // document) are not failures worth a full-panel error.
            if (frame == null || !frame.isMain) return
            if (errorCode == CefLoadHandler.ErrorCode.ERR_ABORTED) return
            if (failedUrl.isNullOrBlank()) return
            log.warn("Pi Agent UI failed to load: $failedUrl — $errorCode $errorText")
            SwingUtilities.invokeLater {
                if (disposed) return@invokeLater
                showFailure(
                    title = "The web UI failed to load",
                    detail = listOf(
                        "The IDE's embedded browser could not open the local UI server.",
                        "Reason: ${errorText ?: errorCode} (${errorCode?.name ?: "unknown"})",
                        "",
                        "If this address opens in a normal browser, the embedded browser",
                        "is being blocked (proxy settings, security software); otherwise",
                        "the local UI server did not start. Attach the idea.log lines",
                        "around this timestamp when reporting it.",
                    ),
                    url = failedUrl,
                )
            }
        }
    }

    /**
     * JCEF console output goes nowhere by default. Mirroring it into idea.log
     * is what makes a "blank panel" report actionable — the frontend's own
     * boot watchdog writes its findings here too.
     */
    private val consoleHandler = object : CefDisplayHandlerAdapter() {
        override fun onConsoleMessage(
            browser: CefBrowser?,
            level: CefSettings.LogSeverity?,
            message: String?,
            source: String?,
            line: Int,
        ): Boolean {
            val text = message ?: return false
            if (level == CefSettings.LogSeverity.LOGSEVERITY_ERROR || text.startsWith("[pi-agent]")) {
                log.warn("JCEF console: $text ($source:$line)")
            } else {
                log.debug("JCEF console: $text ($source:$line)")
            }
            return false
        }
    }

    /**
     * File/folder drags from the IDE (Project View, editor tab) or the OS
     * deliver their real absolute paths only to CEF, never to the page: the
     * HTML5 `drop` event is limited to bare file names for security. Recording
     * them here is what lets the composer show a usable `@relative/path` chip
     * (spec 016); the frontend drains the buffer via `files.takeDrop` when it
     * receives the drop. Returning false keeps CEF's own drop handling.
     */
    private val dragHandler = object : CefDragHandler {
        override fun onDragEnter(browser: CefBrowser?, dragData: CefDragData?, mask: Int): Boolean {
            // CEF 的 CF_HDROP 通道：桌面文件拖入时最准。IDEA 项目树拖拽不一定
            // 填 dragData，那时靠下面的 AWT 旁听补齐；空记录只清 CEF 自己的槽。
            val files = runCatching {
                val names = java.util.Vector<String>()
                if (dragData != null && dragData.isFile && dragData.getFileNames(names)) {
                    names.toList()
                } else {
                    emptyList()
                }
            }.getOrElse { emptyList() }
            if (disposed) return false
            BridgeService.getInstance(project).ideFileDrop.record(files, DropSource.CEF)
            // INFO 而非 DEBUG：真机默认日志级别下也要能一眼看清这次拖拽走了哪条通道。
            log.info("Pi Agent CEF drag: isFile=${dragData?.isFile == true} paths=${files.size} mask=$mask")
            return false
        }
    }

    /** 组件原本没有 DropTarget 时由我们新建，dispose 时一并摘掉。 */
    private var ownedDropTarget: DropTarget? = null

    /**
     * AWT 旁听（spec 016 真机修复）：IDEA 项目树 / 编辑器标签的内部拖拽不一定
     * 走 CF_HDROP，但一定会在 JCEF 组件的 DropTarget 上留下 Transferable。
     * 这里只读数据，不调用 acceptDrop / dropComplete —— CEF 自己仍是 drop 的
     * 处理者，页面若收到 HTML5 drop 就照旧来取缓冲；收不到则由下面的兜底推送。
     */
    private val awtDropListener = object : DropTargetAdapter() {
        override fun dragEnter(e: DropTargetDragEvent) {
            // Java 9+ 允许在拖拽期间读 Transferable，早于页面 drop，避免竞态。
            val t = runCatching { e.transferable }.getOrNull() ?: return
            recordAwt(t, "dragEnter", clearOnEmpty = true)
        }

        override fun dragExit(e: DropTargetEvent) {
            // 拖进来又拖走（没松手）：不能让这批文件挂到下一次无关的 drop 上。
            if (!disposed) BridgeService.getInstance(project).ideFileDrop.record(emptyList(), DropSource.AWT)
        }

        override fun drop(e: DropTargetDropEvent) {
            val t = runCatching { e.transferable }.getOrNull()
            // drop 阶段 AWT 有可能已经把 Transferable 消费掉；读不到时保留
            // dragEnter 记下的路径，不要用空列表覆盖它。
            if (t != null) recordAwt(t, "drop", clearOnEmpty = false)
            scheduleUnclaimedPush()
        }
    }

    private fun recordAwt(t: Transferable, phase: String, clearOnEmpty: Boolean) {
        val paths = runCatching { DropPaths.from(t) }.getOrElse { return }
        if (disposed) return
        // dragEnter 的空记录是有效信息（拖的是文字），drop 阶段的空结果则可能
        // 只是读不到数据，不能把前面记下的真路径抹掉。
        if (paths.isNotEmpty() || clearOnEmpty) {
            BridgeService.getInstance(project).ideFileDrop.record(paths, DropSource.AWT)
        }
        if (paths.isNotEmpty()) log.info("Pi Agent AWT drop: $phase ${paths.size} path(s), first=${paths.first()}")
    }

    private fun installAwtDropListener(component: JComponent) {
        runCatching {
            val existing = component.dropTarget
            if (existing != null) {
                existing.addDropTargetListener(awtDropListener)
                ownedDropTarget = null
                log.info("Pi Agent AWT drop listener attached to the JCEF drop target")
            } else {
                val created = DropTarget(component, awtDropListener)
                component.dropTarget = created
                ownedDropTarget = created
                log.info("Pi Agent AWT drop listener installed as the JCEF drop target")
            }
        }.onFailure { log.warn("Pi Agent AWT drop listener could not be installed", it) }
    }

    /**
     * 页面没来取缓冲就主动注入：IDE 内部拖拽常常根本不会派发 HTML5 drop，
     * 这时 `files.takeDrop` 永远没人调用。600ms 后再看一眼，若还在就说明页面
     * 收不到 drop，直接走已验证可用的 `ide` refs 推送通道把 chip 交给输入框。
     * 页面已经取走时缓冲为空，这里自然不会重复插入。
     */
    private fun scheduleUnclaimedPush() {
        if (disposed) return
        val service = BridgeService.getInstance(project)
        val timer = Timer(UNCLAIMED_DROP_DELAY_MS) {
            val pending = service.ideFileDrop.take()
            if (pending.isEmpty() || disposed) {
                // 页面已经取走（或这次拖拽没有文件）：什么都不用做。
            } else {
                val root = project.basePath?.let { runCatching { java.nio.file.Path.of(it) }.getOrNull() }
                val refs = DropRefs.resolve(root, pending.map { it to false })
                service.pushIdeRefs(refs.map { it.path to it.dir }, fromDrop = true)
                log.info("Pi Agent AWT drop: page did not claim the drop, pushed ${refs.size} ref(s)")
            }
        }
        timer.isRepeats = false
        timer.start()
    }

    init {
        layout = BorderLayout()
        border = BorderFactory.createEmptyBorder()
        // 051: a hidden tool window can lose its page (the renderer may be
        // reaped while the window sits in the background), and the health
        // watch deliberately stays quiet while the panel is hidden — a
        // background tab may legitimately be throttled. So the check has to
        // run again the moment the user comes back, instead of leaving a
        // dead browser on screen for up to one whole tick.
        addComponentListener(object : ComponentAdapter() {
            override fun componentShown(e: ComponentEvent?) {
                SwingUtilities.invokeLater { checkBridgeSilence() }
            }
        })
        mountUi()
        startHealthWatch()
    }

    /**
     * (Re)creates the browser and navigates to this project's UI URL.
     *
     * 051: the whole body is guarded. A failure used to leave the panel with
     * nothing in it — the white rectangle the user reported — and when it
     * happened on the EDT it took the IDE's error handler down with it.
     * Every failure now ends on an error card that names the cause and
     * offers a retry, so the plugin stays usable.
     */
    private fun mountUi() {
        removeAll()
        disposeBrowser()
        mountedAt = System.currentTimeMillis()
        try {
            mountBrowser()
        } catch (t: Throwable) {
            if (t is VirtualMachineError) throw t
            log.warn("Pi Agent UI could not be mounted", t)
            showFailure(
                title = "The embedded browser could not start",
                detail = listOf(
                    "Mounting the UI failed: ${t.message ?: t.javaClass.name}",
                    "",
                    "The plugin itself is still running — press Retry to try again.",
                ),
                url = null,
                releaseBrowser = true,
            )
        }
    }

    /** The mount itself; every step that can fail ends on an error card. */
    private fun mountBrowser() {
        val url = try {
            LocalUiServer.getInstance().uiUrlFor(project, instanceId)
        } catch (t: Throwable) {
            if (t is VirtualMachineError) throw t
            log.warn("Pi Agent UI server unavailable", t)
            showFailure(
                title = "The local UI service could not start",
                detail = listOf(
                    "The plugin serves its UI from a loopback HTTP server, and that server",
                    "did not come up: ${t.message ?: t.javaClass.name}",
                    "",
                    "Usual causes: local port binding blocked by endpoint security, or the",
                    "IDE runtime missing the jdk.httpserver module.",
                ),
                url = null,
            )
            return
        }
        val address = url.substringBefore('?')
        log.info("Pi Agent UI: loading $address")

        // The platform's JBCefApp$Holder class initializer reads proxy settings,
        // which asks for HttpConfigurable (→ ProxyMigrationService) *from inside
        // a class initializer*. IDEA's ComponentManager rejects that with a
        // SEVERE "class initialization must not depend on services" and blames
        // whichever plugin touched JCEF first — us, when the tool window is
        // restored during startup layout ("Plugin to blame: Pi Agent").
        //
        // Touching the service here, outside any initializer, creates it up
        // front: the initializer's lookup then hits an existing instance and
        // never reaches the checked slow path. Harmless when JCEF is
        // unavailable — the service is one JCEF would create anyway — and it
        // costs nothing beyond that one instance.
        runCatching { com.intellij.util.net.HttpConfigurable.getInstance() }
            .onFailure { log.debug("HttpConfigurable pre-init failed", it) }

        if (!JBCefApp.isSupported()) {
            log.warn("JCEF is not supported in this IDE; falling back to the system browser")
            showFailure(
                title = "This IDE cannot host the embedded browser",
                detail = listOf(
                    "JCEF (the Chromium component the panel draws with) is not available",
                    "in this IDE installation, so the UI cannot be shown inside it.",
                    "",
                    "The UI itself is fine: open the address below in any browser.",
                ),
                url = url,
            )
            return
        }

        try {
            // 052: this may be the FIRST browser of the session, and creating
            // it freezes the JCEF log level. Ask for the level that makes GPU
            // crashes readable before that happens.
            JcefLogLevelGuard.ensure()
            val created = JBCefBrowser()
            browser = created
            created.jbCefClient.addRequestHandler(linkHandler, created.cefBrowser)
            created.jbCefClient.addLifeSpanHandler(popupHandler, created.cefBrowser)
            created.jbCefClient.addLoadHandler(loadHandler, created.cefBrowser)
            created.jbCefClient.addDisplayHandler(consoleHandler, created.cefBrowser)
            created.jbCefClient.addDragHandler(dragHandler, created.cefBrowser)
            created.jbCefClient.addContextMenuHandler(contextMenuHandler, created.cefBrowser)
            created.jbCefClient.addKeyboardHandler(keyboardHandler, created.cefBrowser)
            created.jbCefClient.addDownloadHandler(downloadHandler, created.cefBrowser)
            installAwtDropListener(created.component)
            add(created.component, BorderLayout.CENTER)
            created.loadURL(url)
        } catch (t: Throwable) {
            if (t is VirtualMachineError) throw t
            log.warn("JCEF browser could not be created", t)
            showFailure(
                title = "The embedded browser could not start",
                detail = listOf(
                    "JCEF failed to initialise: ${t.message ?: t.javaClass.name}",
                    "",
                    "On Windows this is usually the browser helper process being blocked",
                    "by endpoint security, or a broken IDE runtime. Open the address below",
                    "in a browser to keep working in the meantime.",
                ),
                url = url,
                releaseBrowser = true,
            )
        }
        revalidate()
        repaint()
    }

    /**
     * Puts an error card where the browser used to be.
     *
     * 051: this is the panel's last line of defence against the white
     * rectangle. Every failure path ends here, and the card is built
     * defensively too, so a failure while REPORTING a failure still leaves
     * the user with something readable instead of an empty panel.
     *
     * @param releaseBrowser whether to dispose the embedded browser as well.
     *   Only worth it when the browser is demonstrably dead.
     */
    private fun showFailure(
        title: String,
        detail: List<String>,
        url: String?,
        releaseBrowser: Boolean = false,
    ) {
        removeAll()
        if (releaseBrowser) disposeBrowser()
        val card = try {
            PiUiErrorPanel(title, detail, url, onRetry = ::manualRetry)
        } catch (t: Throwable) {
            if (t is VirtualMachineError) throw t
            log.warn("Pi Agent error card could not be built", t)
            JTextArea(title + "\n\n" + detail.joinToString("\n")).apply { isEditable = false }
        }
        add(card, BorderLayout.CENTER)
        revalidate()
        repaint()
    }

    /**
     * User-initiated retry from an error card. Unlike the automatic rebuild it
     * clears the crash-loop guard: the user asked for another attempt, and the
     * panel may have given up on the previous ones.
     */
    private fun manualRetry() {
        rebuildGaveUp = false
        consecutiveFailures = 0
        mountUi()
    }

    /**
     * 051: rebuilds spent since the page last answered.
     *
     * This replaced a SLIDING WINDOW of rebuild timestamps, and that window
     * WAS the bug: it was 60 seconds wide while the silence threshold that
     * triggers a rebuild is 90 seconds, so every rebuild was the only entry
     * in its own window and the "give up" limit could never be spent. The
     * panel rebuilt the embedded browser every 90 seconds for as long as the
     * page stayed dead — a white rectangle the user could do nothing about
     * (idea.log 2026-11-20: "Rebuilding Pi Agent UI (no bridge poll for 90s)"
     * at 13:30:17, 13:31:47, 13:33:17, 13:34:47).
     *
     * Counting CONSECUTIVE failures cannot be outrun by any threshold: one
     * healthy poll resets the budget.
     */
    private var consecutiveFailures = 0

    /**
     * Set once the crash-loop guard gave up, so the health watch stops
     * retrying (and stops repainting the error card every interval). Cleared
     * only by the user pressing retry on that card.
     */
    private var rebuildGaveUp = false

    /** Starts the repeating check; the first tick lands one interval from now. */
    private fun startHealthWatch() {
        healthWatch.isRepeats = true
        healthWatch.start()
    }

    /**
     * Rebuilds the panel when the frontend has stopped talking to the bridge
     * while being on screen (see [healthWatch]).
     *
     * Skipped when the panel is not showing: a hidden tool window may throttle
     * or freeze its page without anything being wrong, and rebuilding then
     * would throw away a perfectly good page (and any scroll position).
     *
     * 051: the decision itself is [PanelHealth.decide] — a pure function,
     * unit-tested without a project, a browser or a clock. It fixes two
     * things:
     *
     * - only polls made AFTER the current mount count, so the previous
     *   page's last poll cannot keep a dead page looking alive for ever;
     * - the rebuild budget is counted in consecutive failures, so the panel
     *   stops after [PanelHealth.MAX_CONSECUTIVE_FAILURES] attempts instead
     *   of rebuilding every 90 seconds for ever.
     */
    private fun checkBridgeSilence() {
        if (disposed || rebuildGaveUp || browser == null || !isShowing) return
        val now = System.currentTimeMillis()
        val mountAge = now - mountedAt
        val pollAge = try {
            PanelHealth.pollAgeSinceMount(
                currentPollAgeMs = BridgeService.getInstance(project).sinceFrontendPollMs(instanceId),
                mountAgeMs = mountAge,
            )
        } catch (t: Throwable) {
            if (t is VirtualMachineError) throw t
            // A bridge we cannot read counts as a silent page: the
            // consecutive-failure budget decides what happens next.
            log.warn("Pi Agent health check could not read the bridge state", t)
            Long.MAX_VALUE
        }
        val reason = if (pollAge == Long.MAX_VALUE) {
            "the page never polled the bridge"
        } else {
            "no bridge poll for ${pollAge / 1000}s"
        }
        when (PanelHealth.decide(pollAge, mountAge, consecutiveFailures)) {
            PanelHealthDecision.ALIVE -> {
                if (consecutiveFailures != 0) {
                    log.info("Pi Agent UI is answering again after $consecutiveFailures failed attempt(s)")
                    consecutiveFailures = 0
                }
            }
            PanelHealthDecision.PENDING -> Unit
            PanelHealthDecision.REBUILD -> rebuildAfterCrash(reason)
            PanelHealthDecision.GIVE_UP -> giveUp(reason)
        }
    }

    /**
     * Rebuilds the browser after the page stopped working. Must run on the EDT.
     *
     * 051: the budget is [PanelHealth.MAX_CONSECUTIVE_FAILURES] attempts in a
     * row. An IDE whose Web Browser component dies on every load used to
     * rebuild for ever; now the panel parks on an error card with a manual
     * retry, so the user gets a reason instead of a flashing white panel.
     */
    private fun rebuildAfterCrash(reason: String) {
        ApplicationManager.getApplication().invokeLater {
            if (disposed) return@invokeLater
            consecutiveFailures += 1
            log.info("Rebuilding Pi Agent UI ($reason) — attempt $consecutiveFailures")
            mountUi()
        }
    }

    /**
     * 051: the rebuild budget is spent. Park on an actionable card instead of
     * a white rectangle: the user gets the reason, a Retry button and the
     * address to open elsewhere — the plugin stays usable, and pressing
     * Retry starts the budget over.
     */
    private fun giveUp(reason: String) {
        ApplicationManager.getApplication().invokeLater {
            if (disposed) return@invokeLater
            rebuildGaveUp = true
            log.warn("Pi Agent UI keeps failing; not rebuilding again ($reason)")
            val url = runCatching { LocalUiServer.getInstance().uiUrlFor(project, instanceId) }.getOrNull()
            showFailure(
                title = "The embedded browser keeps failing",
                detail = listOf(
                    "The IDE's Chromium component had to be restarted $consecutiveFailures times in a row,",
                    "so the panel stopped reopening itself. Last reason: $reason",
                    "",
                    "This is the IDE's Web Browser component rather than the plugin: restarting",
                    "the IDE usually clears it. Press Retry to try again now — the UI is also",
                    "reachable from a normal browser at the address below.",
                ),
                url = url,
                releaseBrowser = true,
            )
        }
    }

    /**
     * Forces a full CEF frame repaint. Workaround for the JCEF OSR frame lag
     * found on the real machine (0.5.4 GUI test): after a large DOM swap (top
     * tab or manage sub-tab change) the on-screen frame could stay stale for
     * seconds to minutes — the user literally saw the previous view's remains
     * under the new one. The frontend now calls `ide.repaint` after view
     * changes; this invalidates the whole browser frame so CEF resends it.
     *
     * The reflection body lives in `browser/JcefFrameRepaint.kt` since 048:
     * the browser kernel needs the same workaround (spec 048 T005), and two
     * copies of a reflection hack are a regression waiting to happen.
     */
    fun repaintBrowser() {
        dev.pi.agent.browser.JcefFrameRepaint.forceRepaint(browser)
    }

    private fun disposeBrowser() {
        val current = browser ?: return
        browser = null
        runCatching { current.jbCefClient.removeRequestHandler(linkHandler, current.cefBrowser) }
        runCatching { current.jbCefClient.removeLifeSpanHandler(popupHandler, current.cefBrowser) }
        runCatching { current.jbCefClient.removeContextMenuHandler(contextMenuHandler, current.cefBrowser) }
        runCatching { current.jbCefClient.removeKeyboardHandler(keyboardHandler, current.cefBrowser) }
        runCatching { current.jbCefClient.removeDownloadHandle(downloadHandler, current.cefBrowser) }
        runCatching { current.jbCefClient.removeLoadHandler(loadHandler, current.cefBrowser) }
        runCatching { current.jbCefClient.removeDisplayHandler(consoleHandler, current.cefBrowser) }
        runCatching { current.jbCefClient.removeDragHandler(dragHandler, current.cefBrowser) }
        runCatching { current.component.dropTarget?.removeDropTargetListener(awtDropListener) }
        ownedDropTarget = null
        runCatching { current.dispose() }
    }

    override fun dispose() {
        disposed = true
        healthWatch.stop()
        disposeBrowser()
        // ContentManager owns the close decision. The factory asks for
        // confirmation after removal and stops the instance only when the
        // close is accepted; keeping this callback side-effect free lets a
        // cancelled close recreate a fresh panel for the same instance.
    }

    private companion object {
        /** How often the panel checks that the frontend still polls. */
        const val HEALTH_CHECK_INTERVAL_MS = 30_000

        /**
         * 页面 drop 正常时会在几十毫秒内调 `files.takeDrop`；超过这个时间还
         * 留在缓冲里，就认定页面收不到 HTML5 drop，改由 IDE 主动推送引用。
         */
        const val UNCLAIMED_DROP_DELAY_MS = 600

        // 051: the silence threshold and the rebuild budget live in
        // [PanelHealth] — a pure helper, unit-tested without a project, a
        // browser or a clock. They used to be constants here, next to a
        // sliding window that was SHORTER than the threshold itself, which
        // is what made the panel rebuild for ever.
    }
}
