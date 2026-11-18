package dev.pi.agent.browser

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.vfs.VirtualFile
import dev.pi.agent.PiAgentBundle
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

    override fun update(e: AnActionEvent) {
        val project = e.project
        val file = e.getData(PlatformDataKeys.VIRTUAL_FILE)
        e.presentation.isEnabled = project != null && !project.isDisposed &&
            file != null && file.extension?.lowercase() in HTML_EXTENSIONS
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val file = e.getData(PlatformDataKeys.VIRTUAL_FILE) ?: return
        val snapshot = snapshotIntoPreviewRoot(file)
        val token = PiBrowserPreviews.register(snapshot)
        val url = LocalUiServer.getInstance().baseUrl + "preview/" + token
        PiBrowserManager.getInstance(project).open(url)
    }

    /** Copy the file content into the preview root under a flat, unique name. */
    private fun snapshotIntoPreviewRoot(file: VirtualFile): Path {
        val root = PiBrowserPreviews.previewRoot()
        val name = (file.nameWithoutExtension.take(60).ifBlank { "page" }) +
            "-" + System.currentTimeMillis().toString(36) + "." +
            (file.extension?.takeIf { it.isNotBlank() } ?: "html")
        val target = root.resolve(name)
        file.inputStream.use { input -> Files.copy(input, target)
        }
        return target
    }

    private companion object {
        val HTML_EXTENSIONS = setOf("html", "htm")
    }
}
