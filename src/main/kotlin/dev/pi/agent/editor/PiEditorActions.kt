package dev.pi.agent.editor

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.vfs.VirtualFile
import dev.pi.agent.bridge.BridgeService
import java.nio.file.Path

/**
 * The file the action should work on.
 *
 * Project View (new UI, multi-selection, package view) does not always fill
 * [CommonDataKeys.VIRTUAL_FILE] — some contexts only provide
 * [CommonDataKeys.VIRTUAL_FILE_ARRAY]. Reading just the single-value key made
 * every file action grey out in the project tree.
 */
internal fun selectedVirtualFile(e: AnActionEvent): VirtualFile? =
    e.getData(CommonDataKeys.VIRTUAL_FILE)
        ?: e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.firstOrNull()

/**
 * The whole selection behind an update() call: kind for the availability
 * matrix plus whether a multi-selection contains a directory (Add Directory
 * prefers a directory, spec 009 US2 "多选 → 目录优先").
 */
internal fun selectionKind(files: List<VirtualFile>?): Pair<TargetKind, Boolean> = when {
    files.isNullOrEmpty() -> TargetKind.None to false
    files.size > 1 -> TargetKind.Multi to files.any { it.isDirectory }
    else -> {
        val vf = files.first()
        when {
            vf.isDirectory -> TargetKind.Directory
            vf.fileType.isBinary -> TargetKind.Binary
            vf.length > MAX_SEND_FILE_BYTES -> TargetKind.Oversized
            else -> TargetKind.File
        } to false
    }
}

/**
 * Prompt for "Explain File with Pi" (spec 009 T007): directories and binaries
 * send the path only and let pi read from disk (FR-005); text files keep the
 * "summarize and flag" wording with the optional caret location.
 */
internal fun explainPromptFor(kind: TargetKind, path: String, where: String = ""): String = when (kind) {
    TargetKind.Directory ->
        "Look at the directory `$path`. Summarize its structure and purpose (what each subdirectory and key file is for), and flag anything suspicious."
    else ->
        "Look at `$path`$where. Summarize what this file does and flag anything suspicious."
}

/** Project-relative, slash-separated path, or null when it cannot be computed. */
internal fun projectRelativePath(project: Project, vf: VirtualFile?): String? {
    val base = project.basePath ?: return null
    val path = vf?.toNioPath() ?: return null
    return runCatching { Path.of(base).relativize(path).toString().replace('\\', '/') }.getOrNull()
}

/**
 * Editor popup actions that hand the current selection to pi with file:line
 * context. The prompt is pushed to the frontend composer as an `ide` event
 * (see BridgeService.pushIdePrompt); the user can still edit it before sending.
 */
abstract class PiSelectionAction : AnAction() {

    /** Builds the prompt from the selection context. */
    protected abstract fun prompt(selection: String, path: String, line: Int, language: String): String

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val selection = editor.selectionModel.selectedText ?: return
        val vf = selectedVirtualFile(e)
        val line = editor.document.getLineNumber(editor.selectionModel.selectionStart) + 1
        val path = projectRelativePath(project, vf) ?: vf?.name ?: "untitled"

        BridgeService.getInstance(project).pushIdePrompt(prompt(selection, path, line, vf?.extension ?: ""))
        ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
    }

    override fun update(e: AnActionEvent) {
        val hasSelection = e.getData(CommonDataKeys.EDITOR)?.selectionModel?.hasSelection() == true
        e.presentation.isEnabled = e.project != null && hasSelection
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    protected fun codeBlock(selection: String, language: String): String =
        "```$language\n$selection\n```"
}

class SendSelectionToPi : PiSelectionAction() {
    override fun prompt(selection: String, path: String, line: Int, language: String): String =
        "Regarding `$path:$line`:\n${codeBlock(selection, language)}\n"
}

class ExplainWithPi : PiSelectionAction() {
    override fun prompt(selection: String, path: String, line: Int, language: String): String =
        "Explain the following code from `$path:$line` (concise, then any caveats you notice):\n" +
            codeBlock(selection, language) + "\n"
}

class FixWithPi : PiSelectionAction() {
    override fun prompt(selection: String, path: String, line: Int, language: String): String =
        "Fix the following code from `$path:$line`. Provide the corrected code and briefly state what was wrong:\n" +
            codeBlock(selection, language) + "\n"
}

/**
 * "Explain File with Pi" — works from the editor (caret line included) *and*
 * from the project view / editor tab, where there is no editor in the
 * DataContext at all. It only accepted an editor before, so it was permanently
 * greyed out in the project tree even though "the whole file" is exactly the
 * project-view case.
 *
 * Since 0.5.3 it also accepts directories and binaries (path only, pi reads
 * from disk), which is what keeps the popup from being all-grey on a folder
 * (FR-005). update() runs on BGT: the project-tree context is a
 * PreCachedDataContext and refuses data keys requested on the EDT (verified
 * in the sandbox — SEVERE "is requested on EDT by ExplainFileWithPi").
 */
class ExplainFileWithPi : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
        val vf = editor?.let { FileDocumentManager.getInstance().getFile(it.document) }
            ?: selectedVirtualFile(e)
            ?: return
        val path = projectRelativePath(project, vf) ?: vf.name
        val where = editor
            ?.let { " (caret at line ${it.document.getLineNumber(it.caretModel.offset) + 1})" }
            ?: ""
        val (kind, _) = selectionKind(listOf(vf))

        BridgeService.getInstance(project).pushIdePrompt(explainPromptFor(kind, path, where))
        ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
    }

    override fun update(e: AnActionEvent) {
        val (kind, multiHasDirectory) = selectionKind(e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList())
        val a = availability(PiFileAction.ExplainFile, kind, multiHasDirectory)
        e.presentation.isEnabled = e.project != null && a.enabled
        if (!a.enabled) e.presentation.description = a.reason
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}

/**
 * "Send File to Pi Agent" from the project view / editor tab context menu:
 * hands the whole file to pi with its path context. Directories, binaries and
 * oversized files stay disabled — now with the reason in the description and
 * a pointer at the action that *can* handle them (FR-006).
 */
class SendFileToPi : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val vf = selectedVirtualFile(e) ?: return
        val path = projectRelativePath(project, vf) ?: vf.path

        val content = readFileCapped(vf)
            ?: return // binary, oversized or unreadable (update() explains why)

        BridgeService.getInstance(project).pushIdePrompt(
            "Here is the file `$path`. Read it, then wait for my instructions:\n" +
                "```" + (vf.extension ?: "") + "\n$content\n```\n"
        )
        ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
    }

    override fun update(e: AnActionEvent) {
        val (kind, multiHasDirectory) = selectionKind(e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList())
        val a = availability(PiFileAction.SendFile, kind, multiHasDirectory)
        e.presentation.isEnabled = e.project != null && a.enabled
        if (!a.enabled) e.presentation.description = a.reason
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    private fun readFileCapped(vf: com.intellij.openapi.vfs.VirtualFile): String? = try {
        if (vf.length > MAX_SEND_FILE_BYTES) null
        else String(vf.inputStream.readBytes(), Charsets.UTF_8)
    } catch (_: Exception) {
        null
    }
}

/**
 * "Add Directory to Pi" (spec 009 US3): walks the selected directory on a
 * pooled thread and drops a structure summary (paths only, no contents) into
 * the composer. This is the action that keeps a directory right-click usable
 * (FR-003) and replaces "type @ for every file" (SC-003).
 */
class AddDirectoryToPi : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val dir = targetDirectory(e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)) ?: return
        val projectRoot = project.basePath?.let { runCatching { Path.of(it) }.getOrNull() }

        // Activate first so focus lands in the composer while the walk runs.
        ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)

        ApplicationManager.getApplication().executeOnPooledThread {
            val listing = runCatching {
                listDirectory(dir.toNioPath(), projectRoot)
            }.getOrNull() ?: return@executeOnPooledThread
            BridgeService.getInstance(project).pushIdePrompt(directoryPromptFor(listing))
        }
    }

    override fun update(e: AnActionEvent) {
        val (kind, multiHasDirectory) = selectionKind(e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList())
        val a = availability(PiFileAction.AddDirectory, kind, multiHasDirectory)
        e.presentation.isEnabled = e.project != null && a.enabled
        if (!a.enabled) e.presentation.description = a.reason
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    /** Multi-selection prefers the first directory; a single directory is itself. */
    private fun targetDirectory(files: Array<VirtualFile>?): VirtualFile? =
        files?.firstOrNull { it.isDirectory }
}
