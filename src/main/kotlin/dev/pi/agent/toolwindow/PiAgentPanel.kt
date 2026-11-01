package dev.pi.agent.toolwindow

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefBrowser
import dev.pi.agent.ui.LocalUiServer
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.BorderLayout
import javax.swing.BorderFactory
import javax.swing.JPanel

/**
 * Hosts the web UI. The bridge transport is HTTP (loopback, see LocalUiServer),
 * so the panel only needs to point a JCEF browser at the UI server.
 *
 * Navigations away from the UI server (markdown links) are handed to the
 * system browser so they can never hijack the SPA.
 */
class PiAgentPanel(project: Project) : JPanel(), Disposable {

    private val browser = JBCefBrowser()

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

    init {
        layout = BorderLayout()
        border = BorderFactory.createEmptyBorder()
        add(browser.component, BorderLayout.CENTER)
        browser.jbCefClient.addRequestHandler(linkHandler, browser.cefBrowser)
        // uiUrlFor carries this project's bridge token (see LocalUiServer) so
        // each IDE window talks to its own project's bridge.
        browser.loadURL(LocalUiServer.getInstance().uiUrlFor(project))
    }

    override fun dispose() {
        runCatching {
            browser.jbCefClient.removeRequestHandler(linkHandler, browser.cefBrowser)
        }
        browser.dispose()
    }
}
