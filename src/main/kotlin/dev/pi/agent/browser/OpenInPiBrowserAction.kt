package dev.pi.agent.browser

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.vfs.VirtualFile
import dev.pi.agent.PiAgentBundle
import dev.pi.agent.editor.selectedVirtualFile
import dev.pi.agent.ui.LocalUiServer
import java.nio.file.Files
import java.nio.file.Path

/**
 * "Open in Pi Browser" for project HTML files (spec 048 T017, spec US3).
 *
 * The file is COPIED into the one-shot preview root and served through
 * `/preview/<token>` — never `file://` (hard constraint 2): the browser tab
 * would otherwise hand local-path semantics to an untrusted renderer. The
 * preview copy is a snapshot: the tab shows the file as of open time.
 *
 * Action text/description come from the bundle by ID (plugin.xml rule: no
 * `text=` attribute, keys `action.PiAgent.OpenHtmlInBrowser.*`).
 */
class OpenInPiBrowserAction : AnAction() {

    // Match SendFileToPi/ExplainFileWithPi exactly: they read the same data
    // keys in update() on BGT and stay enabled in the project tree. The
    // rollback (1024e89) reverted this to the 048-broken form and the entry
    // went grey again on the real machine (2026-11-21 用户截图).
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        // Read VIRTUAL_FILE_ARRAY (the actual project-tree selection), NOT the
        // single VIRTUAL_FILE key: in the Project View the single key can point
        // at the file open in the editor (e.g. README.md), greying out a
        // perfectly valid HTML right-click.
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.firstOrNull()
        val enabled = project != null && !project.isDisposed &&
            file != null && file.extension?.lowercase() in HTML_EXTENSIONS
        e.presentation.isEnabled = enabled
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val file = selectedVirtualFile(e) ?: return
        val snapshot = snapshotIntoPreviewRoot(file)
        val token = PiBrowserPreviews.register(snapshot)
        val url = LocalUiServer.getInstance().baseUrl + "preview/" + token
        PiBrowserManager.getInstance(project).open(url)
    }

    companion object {
        val HTML_EXTENSIONS = setOf("html", "htm")

        /** Copy the file content into the preview root under a flat, unique name. */
        internal fun snapshotIntoPreviewRoot(file: VirtualFile): Path {
            val root = PiBrowserPreviews.previewRoot()
            val name = (file.nameWithoutExtension.take(60).ifBlank { "page" }) +
                "-" + System.currentTimeMillis().toString(36) + "." +
                (file.extension?.takeIf { it.isNotBlank() } ?: "html")
            val target = root.resolve(name)
            file.inputStream.use { input -> Files.copy(input, target) }
            return target
        }
    }
}
