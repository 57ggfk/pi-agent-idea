package dev.pi.agent.browser

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VirtualFile
import javax.swing.JComponent

/**
 * Editor-form presentation of the in-app browser (spec 048 T019, US9 — the
 * D-track half of 042 Q3's dual carrier). Accepts ONLY the plugin's own
 * preview files ([PiBrowserPreviewFiles.isPreview]) — it must never steal
 * the platform's HTML editor for real project files.
 *
 * v1 simplification (spec-declared): the editor tab runs its OWN kernel, so
 * navigation state is not shared with the tool window tab.
 */
class PiBrowserEditorProvider : FileEditorProvider, DumbAware {

    override fun accept(project: Project, file: VirtualFile): Boolean =
        PiBrowserPreviewFiles.isPreview(file)

    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        PiBrowserFileEditor(project, file)

    override fun getEditorTypeId(): String = "pi-browser-preview"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.NONE
}

internal class PiBrowserFileEditor(private val project: Project, private val file: VirtualFile) : FileEditor {

    private val panel = BrowserPanel(project)

    init {
        Disposer.register(this, panel)
        PiBrowserPreviewFiles.urlOf(file)?.let { panel.load(it) }
    }

    override fun getComponent(): JComponent = panel

    override fun getPreferredFocusedComponent(): JComponent? = null

    override fun getName(): String = dev.pi.agent.PiAgentBundle.message("toolwindow.browser.tab")

    override fun setState(state: com.intellij.openapi.fileEditor.FileEditorState) {}

    override fun getState(level: com.intellij.openapi.fileEditor.FileEditorStateLevel): com.intellij.openapi.fileEditor.FileEditorState =
        object : com.intellij.openapi.fileEditor.FileEditorState {
            // Nothing to persist: the preview tab is a live snapshot and dies
            // with the session (LightVirtualFile is not persisted either).
            override fun canBeMergedWith(otherState: com.intellij.openapi.fileEditor.FileEditorState, level: com.intellij.openapi.fileEditor.FileEditorStateLevel): Boolean = false
        }

    override fun isModified(): Boolean = false

    override fun isValid(): Boolean = !project.isDisposed

    override fun addPropertyChangeListener(listener: java.beans.PropertyChangeListener) {}

    override fun removePropertyChangeListener(listener: java.beans.PropertyChangeListener) {}

    // FileEditor extends UserDataHolder in this version; a plain map is enough
    // — nobody routes user data through a preview editor in P0.
    private val userData = java.util.concurrent.ConcurrentHashMap<com.intellij.openapi.util.Key<*>, Any?>()

    override fun <T : Any> getUserData(key: com.intellij.openapi.util.Key<T>): T? =
        @Suppress("UNCHECKED_CAST") userData[key] as? T

    override fun <T : Any> putUserData(key: com.intellij.openapi.util.Key<T>, value: T?) {
        if (value == null) userData.remove(key) else userData[key] = value
    }

    override fun dispose() {
        Disposer.dispose(panel)
    }
}
