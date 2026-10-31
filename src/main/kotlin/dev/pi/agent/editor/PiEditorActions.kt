package dev.pi.agent.editor

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.vfs.VirtualFile
import dev.pi.agent.bridge.BridgeService
import java.nio.file.Path

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
        val vf = e.getData(CommonDataKeys.VIRTUAL_FILE)
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

    private fun projectRelativePath(project: Project, vf: VirtualFile?): String? {
        val base = project.basePath ?: return null
        val path = vf?.toNioPath() ?: return null
        return runCatching { Path.of(base).relativize(path).toString().replace('\\', '/') }.getOrNull()
    }

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

/** Fallback kept for symmetry: reads the whole file when nothing is selected. */
class ExplainFileWithPi : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val vf = FileDocumentManager.getInstance().getFile(editor.document) ?: return
        val line = editor.document.getLineNumber(editor.caretModel.offset) + 1
        val path = project.basePath?.let { base ->
            runCatching { Path.of(base).relativize(vf.toNioPath()).toString().replace('\\', '/') }.getOrNull()
        } ?: vf.name

        BridgeService.getInstance(project).pushIdePrompt(
            "Look at `$path` (caret at line $line). Summarize what this file does and flag anything suspicious."
        )
        ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
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
        val vf = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val path = project.basePath?.let { base ->
            runCatching { Path.of(base).relativize(vf.toNioPath()).toString().replace('\\', '/') }.getOrNull()
        } ?: vf.path

        val content = readFileCapped(vf)
            ?: return // binary or unreadable (update() should have disabled)

        BridgeService.getInstance(project).pushIdePrompt(
            "Here is the file `$path`. Read it, then wait for my instructions:\n" +
                "```" + (vf.extension ?: "") + "\n$content\n```\n"
        )
        ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
    }

    override fun update(e: AnActionEvent) {
        val vf = e.getData(CommonDataKeys.VIRTUAL_FILE)
        e.presentation.isEnabled = e.project != null
            && vf != null
            && !vf.isDirectory
            && !vf.fileType.isBinary
            && vf.length <= MAX_FILE_BYTES
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    private fun readFileCapped(vf: com.intellij.openapi.vfs.VirtualFile): String? = try {
        if (vf.length > MAX_FILE_BYTES) null
        else String(vf.inputStream.readBytes(), Charsets.UTF_8)
    } catch (_: Exception) {
        null
    }

    companion object {
        private const val MAX_FILE_BYTES = 256L * 1024
    }
}
