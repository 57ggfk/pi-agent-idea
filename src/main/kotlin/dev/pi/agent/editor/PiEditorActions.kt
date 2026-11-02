package dev.pi.agent.editor

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
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

/** Project-relative, slash-separated path, or null when it cannot be computed. */
internal fun projectRelativePath(project: Project, vf: VirtualFile?): String? {
    val base = project.basePath ?: return null
    val path = vf?.toNioPath() ?: return null
    return runCatching { Path.of(base).relativize(path).toString().replace('\\', '/') }.getOrNull()
}

/** Why a whole-file action cannot run for [vf]; null means "go ahead". */
internal fun fileActionBlockReason(vf: VirtualFile?): String? = when {
    vf == null -> "Select a file first"
    vf.isDirectory -> "Folders cannot be sent to pi"
    vf.fileType.isBinary -> "Binary files cannot be sent to pi"
    vf.length > MAX_FILE_BYTES -> "File is larger than ${MAX_FILE_BYTES / 1024} KB"
    else -> null
}

private const val MAX_FILE_BYTES = 256L * 1024

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

        BridgeService.getInstance(project).pushIdePrompt(
            "Look at `$path`$where. Summarize what this file does and flag anything suspicious."
        )
        ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
    }

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        val vf = selectedVirtualFile(e)
        val reason = when {
            e.project == null -> "No project"
            editor != null -> null
            else -> fileActionBlockReason(vf)
        }
        e.presentation.isEnabled = reason == null
        if (reason != null) e.presentation.description = reason
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
}

/**
 * "Send File to Pi Agent" from the project view / editor tab context menu:
 * hands the whole file to pi with its path context.
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
        val reason = if (e.project == null) "No project" else fileActionBlockReason(selectedVirtualFile(e))
        e.presentation.isEnabled = reason == null
        if (reason != null) e.presentation.description = reason
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    private fun readFileCapped(vf: com.intellij.openapi.vfs.VirtualFile): String? = try {
        if (vf.length > MAX_FILE_BYTES) null
        else String(vf.inputStream.readBytes(), Charsets.UTF_8)
    } catch (_: Exception) {
        null
    }
}
