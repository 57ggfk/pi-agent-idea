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
        PiProcessManager.getInstance(project).addStateListener(listener = stateListener)
    }

    override fun ID(): String = PiStatusBarWidgetFactory.ID

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    private fun activeInstance(): Int {
        val content = ToolWindowManager.getInstance(project)
            .getToolWindow("Pi Agent")
            ?.contentManager
            ?.selectedContent
        return (content?.component as? PiAgentPanel)?.id ?: 1
    }

    private fun activeState(): PiConnectionState {
        val id = activeInstance()
        return PiProcessManager.getInstance(project).stateOf(id)
    }

    private fun instanceSummary(): String {
        val count = PiProcessManager.getInstance(project).liveInstanceIds().size
        return if (count > 1) "Pi ${activeInstance()} / $count" else "Pi 1"
    }

    override fun getText(): String = when (val s = activeState()) {
        is PiConnectionState.Running -> "${instanceSummary()} ${s.installation.version ?: ""}".trim()
        is PiConnectionState.Starting -> "${instanceSummary()} …"
        is PiConnectionState.Exited -> "${instanceSummary()} ⚠"
        PiConnectionState.NotStarted -> instanceSummary()
    }

    override fun getTooltipText(): String = when (val s = activeState()) {
        is PiConnectionState.Running ->
            "${instanceSummary()}: " + PiAgentBundle.message("status.running") +
                (s.installation.version?.let { " ($it)" } ?: "") + diskVersionNote()
        is PiConnectionState.Starting -> "${instanceSummary()}: " + PiAgentBundle.message("status.starting")
        is PiConnectionState.Exited -> "${instanceSummary()}: " + PiAgentBundle.message("status.exited", s.message ?: "")
        PiConnectionState.NotStarted -> "${instanceSummary()}: " + PiAgentBundle.message("status.notStarted")
    }

    /**
     * A note about the on-disk installation, when it differs from the running
     * one — the user upgraded pi outside the IDE and the running process
     * still has the old code (issue #6). Silent otherwise.
     */
    private fun diskVersionNote(): String {
        val running = (activeState() as? PiConnectionState.Running)?.installation?.version
        val disk = dev.pi.agent.process.PiDiskVersion.current() ?: return ""
        if (running == null || disk == running) return ""
        return " — " + PiAgentBundle.message("status.diskVersion", disk)
    }

    override fun getAlignment(): Float = 0.5f

    override fun getClickConsumer(): Consumer<MouseEvent>? = Consumer {
        ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
    }

    override fun dispose() {
        PiProcessManager.getInstance(project).removeStateListener(listener = stateListener)
    }
}
