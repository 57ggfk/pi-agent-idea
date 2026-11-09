package dev.pi.agent.toolwindow

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import dev.pi.agent.bridge.BridgeService
import dev.pi.agent.ui.LocalUiServer
import dev.pi.agent.ui.PiUiErrorPanel
import org.cef.CefSettings
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefDragData
import org.cef.handler.CefDisplayHandlerAdapter
import org.cef.handler.CefDragHandler
import org.cef.handler.CefLoadHandler
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.BorderLayout
import javax.swing.BorderFactory
import javax.swing.JPanel
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
class PiAgentPanel(private val project: Project) : JPanel(), Disposable {

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
            if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) return false
            BrowserUtil.browse(url)
            return true // cancel in-IDE navigation
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
            // Always record — an empty list is meaningful: this drag carries no
            // files, so a file batch recorded moments ago must not leak into it.
            val files = runCatching {
                val names = java.util.Vector<String>()
                if (dragData != null && dragData.isFile && dragData.getFileNames(names)) {
                    names.toList()
                } else {
                    emptyList()
                }
            }.getOrElse { emptyList() }
            if (disposed) return false
            BridgeService.getInstance(project).ideFileDrop.record(files)
            if (files.isNotEmpty()) log.debug("Pi Agent drop: ${files.size} path(s) entered the browser")
            return false
        }
    }

    init {
        layout = BorderLayout()
        border = BorderFactory.createEmptyBorder()
        mountUi()
        startHealthWatch()
    }

    /** (Re)creates the browser and navigates to this project's UI URL. */
    private fun mountUi() {
        removeAll()
        disposeBrowser()
        mountedAt = System.currentTimeMillis()

        val url = try {
            LocalUiServer.getInstance().uiUrlFor(project)
        } catch (t: Throwable) {
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
            val created = JBCefBrowser()
            browser = created
            created.jbCefClient.addRequestHandler(linkHandler, created.cefBrowser)
            created.jbCefClient.addLoadHandler(loadHandler, created.cefBrowser)
            created.jbCefClient.addDisplayHandler(consoleHandler, created.cefBrowser)
            created.jbCefClient.addDragHandler(dragHandler, created.cefBrowser)
            add(created.component, BorderLayout.CENTER)
            created.loadURL(url)
        } catch (t: Throwable) {
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
            )
        }
        revalidate()
        repaint()
    }

    private fun showFailure(title: String, detail: List<String>, url: String?) {
        removeAll()
        add(
            PiUiErrorPanel(title, detail, url, onRetry = ::manualRetry),
            BorderLayout.NORTH,
        )
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
        synchronized(rebuildStamps) { rebuildStamps.clear() }
        mountUi()
    }

    /** Timestamps of the automatic rebuilds, for the crash-loop guard. */
    private val rebuildStamps = ArrayDeque<Long>()

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
     */
    private fun checkBridgeSilence() {
        if (disposed || rebuildGaveUp || browser == null || !isShowing) return
        // Count from the later of "document loaded" and "last poll": a freshly
        // mounted panel is silent for a moment before its first request.
        val silentFor = minOf(
            BridgeService.getInstance(project).sinceFrontendPollMs(),
            System.currentTimeMillis() - mountedAt,
        )
        if (silentFor <= BRIDGE_SILENCE_MS) return
        rebuildAfterCrash("no bridge poll for ${silentFor / 1000}s")
    }

    /**
     * Rebuilds the browser after the page stopped working. Must run on the EDT.
     *
     * Guarded by [MAX_REBUILDS_PER_WINDOW]: an IDE whose Web Browser component
     * dies on every load would otherwise rebuild forever in the background.
     * Past the limit the panel parks on an error card with a manual retry, so
     * the user gets a reason instead of a flashing panel.
     */
    private fun rebuildAfterCrash(reason: String) {
        ApplicationManager.getApplication().invokeLater {
            if (disposed) return@invokeLater
            val now = System.currentTimeMillis()
            val attempts = synchronized(rebuildStamps) {
                while (rebuildStamps.isNotEmpty() && now - rebuildStamps.first() > REBUILD_WINDOW_MS) {
                    rebuildStamps.removeFirst()
                }
                rebuildStamps.addLast(now)
                rebuildStamps.size
            }
            if (attempts > MAX_REBUILDS_PER_WINDOW) {
                log.warn("Pi Agent UI keeps failing; not rebuilding again ($reason)")
                rebuildGaveUp = true
                val url = runCatching { LocalUiServer.getInstance().uiUrlFor(project) }.getOrNull()
                showFailure(
                    title = "The embedded browser keeps failing",
                    detail = listOf(
                        "The IDE's Chromium component had to be restarted $attempts times in the last",
                        "minute, so the panel stopped reopening itself. Last reason: $reason",
                        "",
                        "This is the IDE's Web Browser component rather than the plugin: restarting",
                        "the IDE usually clears it. The UI is also reachable from a normal browser",
                        "at the address below.",
                    ),
                    url = url,
                )
                return@invokeLater
            }
            log.info("Rebuilding Pi Agent UI ($reason)")
            mountUi()
        }
    }

    /**
     * Forces a full CEF frame repaint. Workaround for the JCEF OSR frame lag
     * found on the real machine (0.5.4 GUI test): after a large DOM swap (top
     * tab or manage sub-tab change) the on-screen frame could stay stale for
     * seconds to minutes — the user literally saw the previous view's remains
     * under the new one. The frontend now calls `ide.repaint` after view
     * changes; this invalidates the whole browser frame so CEF resends it.
     */
    fun repaintBrowser() {
        val current = browser ?: return
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            runCatching {
                val component = current.component
                component.revalidate()
                component.repaint()
                // CefBrowser_N.wasResized forces the renderer to produce a
                // fresh full frame even at an unchanged size — the direct fix
                // for the stale-frame lag. The impl class is package-private,
                // so reach it reflectively; CefBrowser.invalidate() is
                // protected and equally unreachable from a plugin.
                val cef = current.cefBrowser
                cef.javaClass
                    .getMethod("wasResized", Integer.TYPE, Integer.TYPE)
                    .apply { isAccessible = true }
                    .invoke(cef, component.width.coerceAtLeast(1), component.height.coerceAtLeast(1))
            }
        }
    }

    private fun disposeBrowser() {
        val current = browser ?: return
        browser = null
        runCatching { current.jbCefClient.removeRequestHandler(linkHandler, current.cefBrowser) }
        runCatching { current.jbCefClient.removeLoadHandler(loadHandler, current.cefBrowser) }
        runCatching { current.jbCefClient.removeDisplayHandler(consoleHandler, current.cefBrowser) }
        runCatching { current.jbCefClient.removeDragHandler(dragHandler, current.cefBrowser) }
        runCatching { current.dispose() }
    }

    override fun dispose() {
        disposed = true
        healthWatch.stop()
        disposeBrowser()
    }

    private companion object {
        /** How often the panel checks that the frontend still polls. */
        const val HEALTH_CHECK_INTERVAL_MS = 30_000

        /**
         * Silence tolerated before rebuilding. The frontend polls every 20s, so
         * this is more than four missed rounds — long enough that a slow
         * machine cannot trip it, short enough that a dead page heals itself
         * before the user gives up on it.
         */
        const val BRIDGE_SILENCE_MS = 90_000L

        /** Sliding window for the crash-loop guard. */
        const val REBUILD_WINDOW_MS = 60_000L

        /** Rebuilds tolerated inside [REBUILD_WINDOW_MS] before giving up. */
        const val MAX_REBUILDS_PER_WINDOW = 2
    }
}
