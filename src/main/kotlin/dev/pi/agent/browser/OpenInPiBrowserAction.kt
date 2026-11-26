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
 * "Open in Pi Browser" for project HTML files (spec 060 T017, spec US3).
 *
 * Local files load through a `file:///` URL DIRECTLY (066 变更 3): spec 060
 * hard constraint 2 ("never `file://` — hand local-path semantics to an
 * untrusted renderer") was RELAXED by explicit user authorization
 * (2026-11-21). The relaxation is bounded to exactly this action:
 *
 *  - the user ACTIVELY opens a project file via a right-click "Open in Pi
 *    Browser" — no chat link, no agent tool call, no preview route can
 *    inject a `file://` navigation into a browser tab;
 *  - the URL is built from the VFS file the user selected, not from any
 *    page-supplied string — a renderer cannot point the tab at a new local
 *    file by itself ([FileUrls.forLocalFile] only ever encodes the path it
 *    is handed);
 *  - non-local VFS entries (jar/library files) keep the one-shot preview
 *    route below, and the chat export preview ([PiBrowserPreviews]) keeps
 *    its token route — the preview registry never becomes a file:// helper.
 *
 * Compared with the old snapshot route this also fixes two real defects: the
 * open no longer occupies a `/preview/<token>` route (the token TTL outlived
 * nothing — a reload after TTL turned into a 404 error card), and there is
 * no token expiry for the tab to fall off of.
 *
 * Action text/description come from the bundle by ID (plugin.xml rule: no
 * `text=` attribute, keys `action.PiAgent.OpenHtmlInBrowser.*`).
 */
class OpenInPiBrowserAction : AnAction() {

    // Match SendFileToPi/ExplainFileWithPi exactly: they read the same data
    // keys in update() on BGT and stay enabled in the project tree. The
    // rollback (1024e89) reverted this to the 060-broken form and the entry
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
        PiBrowserManager.getInstance(project).open(previewTargetUrl(file))
    }

    companion object {
        val HTML_EXTENSIONS = setOf("html", "htm")

        /**
         * The URL the browser tab should load for [file]. Local project
         * files: a `file:///` URL built by [FileUrls] (066 变更 3, see the
         * class comment for the authorization boundary). Non-local VFS
         * entries: the 060 snapshot route (copy into the preview root + a
         * one-shot token) — `file.path` there is a jar URL, not a filesystem
         * path, and the preview root is exactly the whitelisted place for it.
         */
        internal fun previewTargetUrl(file: VirtualFile): String {
            if (file.isInLocalFileSystem) {
                return FileUrls.forLocalFile(file.path)
            }
            val snapshot = snapshotIntoPreviewRoot(file)
            return LocalUiServer.getInstance().baseUrl + "preview/" + PiBrowserPreviews.register(snapshot)
        }

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
