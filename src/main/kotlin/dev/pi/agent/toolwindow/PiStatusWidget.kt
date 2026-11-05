package dev.pi.agent.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.WindowManager
import com.intellij.util.Consumer
import dev.pi.agent.PiAgentBundle
import dev.pi.agent.process.PiConnectionState
import dev.pi.agent.process.PiProcessManager
import java.awt.event.MouseEvent

/** Shows the pi process state (and on click, opens the tool window). */
class PiStatusBarWidgetFactory : StatusBarWidgetFactory {

    override fun getId(): String = ID

    override fun getDisplayName(): String = "Pi Agent"

    override fun createWidget(project: Project): StatusBarWidget = PiStatusWidget(project)

    override fun disposeWidget(widget: StatusBarWidget) {
        Disposer.dispose(widget)
    }

    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true

    companion object {
        const val ID = "PiAgentStatusBarWidget"
    }
}

class PiStatusWidget(private val project: Project) :
    StatusBarWidget, StatusBarWidget.TextPresentation {

    @Volatile
    private var state: PiConnectionState = PiProcessManager.getInstance(project).state

    private val stateListener = { newState: PiConnectionState ->
        state = newState
        // Repaint every status bar this project is shown on (best effort).
        try {
            WindowManager.getInstance().getStatusBar(project)?.updateWidget(ID())
        } catch (_: Exception) {
            // status bar not available yet
        }
        Unit
    }

    init {
        PiProcessManager.getInstance(project).addStateListener(stateListener)
    }

    override fun ID(): String = PiStatusBarWidgetFactory.ID

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun getText(): String = when (val s = state) {
        is PiConnectionState.Running -> "π ${s.installation.version ?: ""}".trim()
        is PiConnectionState.Starting -> "π …"
        is PiConnectionState.Exited -> "π ⚠"
        PiConnectionState.NotStarted -> "π"
    }

    override fun getTooltipText(): String = when (val s = state) {
        is PiConnectionState.Running ->
            PiAgentBundle.message("status.running") + (s.installation.version?.let { " ($it)" } ?: "")
        is PiConnectionState.Starting -> PiAgentBundle.message("status.starting")
        is PiConnectionState.Exited -> PiAgentBundle.message("status.exited", s.message ?: "")
        PiConnectionState.NotStarted -> PiAgentBundle.message("status.notStarted")
    }

    override fun getAlignment(): Float = 0.5f

    override fun getClickConsumer(): Consumer<MouseEvent>? = Consumer {
        ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
    }

    override fun dispose() {
        PiProcessManager.getInstance(project).removeStateListener(stateListener)
    }
}
