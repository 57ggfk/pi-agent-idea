package dev.pi.agent.toolwindow

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import dev.pi.agent.ui.LocalUiServer
import dev.pi.agent.ui.PiUiErrorPanel
import org.cef.CefSettings
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefDisplayHandlerAdapter
import org.cef.handler.CefLoadHandler
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.BorderLayout
import javax.swing.BorderFactory
import javax.swing.JPanel
import javax.swing.SwingUtilities

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

    init {
        layout = BorderLayout()
        border = BorderFactory.createEmptyBorder()
        mountUi()
    }

    /** (Re)creates the browser and navigates to this project's UI URL. */
    private fun mountUi() {
        removeAll()
        disposeBrowser()

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
            PiUiErrorPanel(title, detail, url, onRetry = if (url != null) ::mountUi else null),
            BorderLayout.NORTH,
        )
        revalidate()
        repaint()
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
        runCatching { current.dispose() }
    }

    override fun dispose() {
        disposed = true
        disposeBrowser()
    }
}
