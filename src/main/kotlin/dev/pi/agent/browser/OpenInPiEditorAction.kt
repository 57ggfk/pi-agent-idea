package dev.pi.agent.browser

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileEditorManager
import dev.pi.agent.editor.selectedVirtualFile

/**
 * "Open in Editor (Pi preview)" — the editor-form entry (spec 060 T019, US9).
 *
 * URL routing follows [OpenInPiBrowserAction.previewTargetUrl] (066 变更 3):
 * local project files ride a direct `file:///` URL — same user-authorized
 * relaxation of 060 hard constraint 2 as the browser-tab action (only files
 * the user actively opens; see that class comment for the boundary) — while
 * non-local VFS entries keep the snapshot + token route. The URL rides on a
 * LightVirtualFile the provider claims; the suggested tab name is the real
 * file name, so a local open keeps its name instead of a "page" fallback.
 */
class OpenInPiEditorAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        // Read VIRTUAL_FILE_ARRAY (the tree selection), not the single key —
        // see OpenInPiBrowserAction.update for why the single key misleads.
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.firstOrNull()
        e.presentation.isEnabled = project != null && !project.isDisposed &&
            file != null && file.extension?.lowercase() in OpenInPiBrowserAction.HTML_EXTENSIONS
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val file = selectedVirtualFile(e) ?: return
        val url = OpenInPiBrowserAction.previewTargetUrl(file)
        val vf = PiBrowserPreviewFiles.create(file.name, url)
        FileEditorManager.getInstance(project).openFile(vf, true)
    }
}
