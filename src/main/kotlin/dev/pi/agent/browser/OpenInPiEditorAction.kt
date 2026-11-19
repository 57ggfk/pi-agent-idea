package dev.pi.agent.browser

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.fileEditor.FileEditorManager
import dev.pi.agent.ui.LocalUiServer
import java.nio.file.Files

/**
 * "Open in Editor (Pi preview)" — the editor-form entry (spec 048 T019, US9).
 * Same one-shot snapshot mechanics as [OpenInPiBrowserAction]; the preview
 * URL rides on a LightVirtualFile the provider claims.
 */
class OpenInPiEditorAction : AnAction() {

    override fun update(e: AnActionEvent) {
        val project = e.project
        val file = e.getData(PlatformDataKeys.VIRTUAL_FILE)
        e.presentation.isEnabled = project != null && !project.isDisposed &&
            file != null && file.extension?.lowercase() in HTML_EXTENSIONS
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val file = e.getData(PlatformDataKeys.VIRTUAL_FILE) ?: return
        val snapshot = OpenInPiBrowserAction.snapshotIntoPreviewRoot(file)
        val token = PiBrowserPreviews.register(snapshot)
        val url = LocalUiServer.getInstance().baseUrl + "preview/" + token
        val vf = PiBrowserPreviewFiles.create(file.name, url)
        FileEditorManager.getInstance(project).openFile(vf, true)
    }

    private companion object {
        val HTML_EXTENSIONS = setOf("html", "htm")
    }
}
