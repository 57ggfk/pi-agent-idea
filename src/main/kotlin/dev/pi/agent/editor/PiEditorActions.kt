package dev.pi.agent.editor

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.vfs.VirtualFile
import dev.pi.agent.PiAgentBundle
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
 * Prompt for "Explain File with Pi" (spec 015): the file itself travels as a
 * reference chip pushed alongside this prompt, so the text carries only the
 * intent — no path, no contents — with the optional caret location appended.
 */
internal fun explainPromptFor(isDirectory: Boolean, where: String = ""): String =
    PiAgentBundle.message(if (isDirectory) "prompt.explain.dir" else "prompt.explain.file") + where

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
        PiAgentBundle.message("prompt.sendSelection", "$path:$line") + codeBlock(selection, language) + "\n"
}

class ExplainWithPi : PiSelectionAction() {
    override fun prompt(selection: String, path: String, line: Int, language: String): String =
        PiAgentBundle.message("prompt.explainSelection", "$path:$line") + codeBlock(selection, language) + "\n"
}

class FixWithPi : PiSelectionAction() {
    override fun prompt(selection: String, path: String, line: Int, language: String): String =
        PiAgentBundle.message("prompt.fixSelection", "$path:$line") + codeBlock(selection, language) + "\n"
}

/**
 * "Explain File with Pi" — works from the editor (caret line included) *and*
 * from the project view / editor tab, where there is no editor in the
 * DataContext at all. It only accepted an editor before, so it was permanently
 * greyed out in the project tree even though "the whole file" is exactly the
 * project-view case.
 *
 * Since 0.5.6 the file rides along as a reference chip (spec 015) and the
 * prompt is a localized sentence of intent — pi reads the file from disk, so
 * directories and binaries work identically. update() runs on BGT: the
 * project-tree context is a PreCachedDataContext and refuses data keys
 * requested on the EDT (verified in the sandbox — SEVERE "is requested on EDT
 * by ExplainFileWithPi").
 */
class ExplainFileWithPi : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
        val vf = editor?.let { FileDocumentManager.getInstance().getFile(it.document) }
            ?: selectedVirtualFile(e)
            ?: return
        val where = editor
            ?.let { " " + PiAgentBundle.message("prompt.explain.caret", it.document.getLineNumber(it.caretModel.offset) + 1) }
            ?: ""

        BridgeService.getInstance(project).pushIdePrompt(
            explainPromptFor(vf.isDirectory, where),
            listOf((projectRelativePath(project, vf) ?: vf.path) to vf.isDirectory),
        )
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
 * "Send File to Pi Agent" from the project view / editor tab context menu.
 * Since spec 015 the file travels as a path reference only — nothing is read,
 * so binaries and oversized files work too (the availability matrix was
 * widened accordingly). Directories still point at Add Directory.
 */
class SendFileToPi : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val vf = selectedVirtualFile(e) ?: return

        BridgeService.getInstance(project)
            .pushIdeRefs(listOf((projectRelativePath(project, vf) ?: vf.path) to false))
        ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
    }

    override fun update(e: AnActionEvent) {
        val (kind, multiHasDirectory) = selectionKind(e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList())
        val a = availability(PiFileAction.SendFile, kind, multiHasDirectory)
        e.presentation.isEnabled = e.project != null && a.enabled
        if (!a.enabled) e.presentation.description = a.reason
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}

/**
 * "Add Directory to Pi" (spec 009 US3, simplified by spec 015): the directory
 * becomes a single reference chip in the composer — pi lists and reads it
 * itself, so there is no walk, no entry list and no pooled thread here
 * anymore. This is the action that keeps a directory right-click usable
 * (FR-003) and replaces "type @ for every file" (SC-003).
 */
class AddDirectoryToPi : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val dir = targetDirectory(e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)) ?: return

        BridgeService.getInstance(project)
            .pushIdeRefs(listOf((projectRelativePath(project, dir) ?: dir.path) to true))
        ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")?.activate(null)
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
