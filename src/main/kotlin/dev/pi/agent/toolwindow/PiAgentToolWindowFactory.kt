package dev.pi.agent.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import dev.pi.agent.bridge.BridgeService
import dev.pi.agent.ui.LocalUiServer
import org.cef.browser.CefBrowser
import org.cef.handler.CefLoadHandler
import javax.swing.BorderFactory
import javax.swing.JPanel

private const val SEND_FUNC = "__piSend"

class PiAgentToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val content = ContentFactory.getInstance().createContent(PiAgentPanel(project), "", false)
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project): Boolean = true
}

class PiAgentPanel(project: Project) : JPanel(), com.intellij.openapi.Disposable {

    private val browser = JBCefBrowser()

    init {
        layout = java.awt.BorderLayout()
        border = BorderFactory.createEmptyBorder()
        add(browser.component, java.awt.BorderLayout.CENTER)

        val bridge = BridgeService.getInstance(project)

        // JS → Java channel. The handler returns immediately; replies are pushed
        // asynchronously as `resp` records (long-running RPC must not block CEF IO).
        val query = JBCefJSQuery.create(browser)
        query.addHandler { message ->
            bridge.handleMessage(message)
            JBCefJSQuery.Response("ok")
        }

        val loadHandler = object : CefLoadHandler {
            override fun onLoadingStateChange(
                cefBrowser: CefBrowser,
                isLoading: Boolean,
                canGoBack: Boolean,
                canGoForward: Boolean,
            ) {
                if (!isLoading) {
                    bridge.registerSink(cefBrowser)
                    val inject = query.inject(SEND_FUNC) +
                        ";if (window.__piBridgeInjected) window.__piBridgeInjected();"
                    cefBrowser.executeJavaScript(inject, LocalUiServer.getInstance().baseUrl, 0)
                }
            }

            override fun onLoadStart(cefBrowser: CefBrowser, frame: org.cef.browser.CefFrame, transitionType: org.cef.network.CefRequest.TransitionType) {}

            override fun onLoadEnd(cefBrowser: CefBrowser, frame: org.cef.browser.CefFrame, httpStatusCode: Int) {}

            override fun onLoadError(
                cefBrowser: CefBrowser,
                frame: org.cef.browser.CefFrame,
                errorCode: CefLoadHandler.ErrorCode,
                errorText: String,
                failedUrl: String,
            ) {}
        }
        browser.jbCefClient.addLoadHandler(loadHandler, browser.cefBrowser)

        browser.loadURL(LocalUiServer.getInstance().baseUrl)
    }

    override fun dispose() {
        browser.dispose()
    }
}
