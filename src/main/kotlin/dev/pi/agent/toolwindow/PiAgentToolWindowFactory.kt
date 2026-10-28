package dev.pi.agent.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefBrowser
import dev.pi.agent.ui.LocalUiServer
import javax.swing.BorderFactory
import javax.swing.JPanel

class PiAgentToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val content = ContentFactory.getInstance().createContent(PiAgentPanel(project), "", false)
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project): Boolean = true
}

/**
 * Hosts the web UI. The bridge transport is HTTP (loopback, see LocalUiServer),
 * so the panel only needs to point a JCEF browser at the UI server.
 */
class PiAgentPanel(project: Project) : JPanel(), com.intellij.openapi.Disposable {

    private val browser = JBCefBrowser()

    init {
        layout = java.awt.BorderLayout()
        border = BorderFactory.createEmptyBorder()
        add(browser.component, java.awt.BorderLayout.CENTER)
        browser.loadURL(LocalUiServer.getInstance().baseUrl)
    }

    override fun dispose() {
        browser.dispose()
    }
}
