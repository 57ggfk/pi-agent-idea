package dev.pi.agent.browser

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VirtualFile
import java.net.URLDecoder
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

    companion object {

        /**
         * Static open entry (054 变更 1): opens [url] in an editor-form
         * browser tab and returns whether it was opened. Shared by the link
         * right-click menu's "Open in Pi editor" and the overflow menu's
         * editor switch. The tab is a [LightVirtualFile] carrying the URL in
         * userData — exactly the claim pattern of [PiBrowserPreviewFiles]
         * (marker + URL key), so [PiBrowserFileEditor] picks it up on
         * creation; openFile is an EDT call, callers hop first.
         */
        @JvmStatic
        fun openUrlInEditor(project: Project, url: String, suggestedName: String?): Boolean {
            if (project.isDisposed) return false
            if (url.isBlank()) return false
            val name = suggestedName?.takeIf { it.isNotBlank() } ?: pageNameFromUrl(url)
            val vf = PiBrowserPreviewFiles.create(name, url)
            FileEditorManager.getInstance(project).openFile(vf, true)
            return true
        }

        /**
         * Pure tab-title guess from a URL: the last path segment
         * (percent-decoded), falling back to the host (without port), then
         * to "page". Unit-tested in [PiBrowserEditorOpenTest].
         */
        @JvmStatic
        fun pageNameFromUrl(url: String): String {
            val afterScheme = url.trim().substringAfter("://", missingDelimiterValue = "")
            if (afterScheme.isEmpty()) return "page"
            // Default missing-delimiter values matter here: a host-only URL
            // ("http://127.0.0.1:8080") has no '/', a normal authority has no
            // '@' — either missing case must keep the whole part, not "".
            val authority = hostWithoutPort(
                afterScheme.substringBefore('/').substringAfterLast('@'),
            )
            if (!afterScheme.contains('/')) return authority.ifBlank { "page" }
            val path = afterScheme.substringAfter('/').substringBefore('#').substringBefore('?')
            val segment = path.substringAfterLast('/', "").trim()
            if (segment.isBlank()) return authority.ifBlank { "page" }
            return decodePercent(segment)
                ?.takeIf { it.isNotBlank() && !it.contains('/') && !it.contains('\\') }
                ?: UrlNormalizer.downloadFileName(segment)
        }

        /** `host:port` -> `host`; IPv6 literals (`[::1]:8080`) lose the port too. */
        private fun hostWithoutPort(authority: String): String {
            val colon = authority.lastIndexOf(':')
            if (colon <= 0) return authority
            val port = authority.substring(colon + 1)
            return if (port.all { it.isDigit() } && port.isNotEmpty()) authority.substring(0, colon) else authority
        }

        /** Decodes `%XX` escapes only — `+` must stay `+` in a path segment. */
        private fun decodePercent(segment: String): String? {
            if (!segment.contains('%')) return segment
            return try {
                URLDecoder.decode(segment.replace("+", "%2B"), Charsets.UTF_8)
            } catch (_: Exception) {
                null
            }
        }
    }
}

internal class PiBrowserFileEditor(private val project: Project, private val file: VirtualFile) : FileEditor {

    private val panel = BrowserPanel(project, carrier = BrowserCarrier.EDITOR)

    init {
        Disposer.register(this, panel)
        PiBrowserPreviewFiles.urlOf(file)?.let { panel.load(it) }
    }

    override fun getComponent(): JComponent = panel

    override fun getPreferredFocusedComponent(): JComponent? = null

    /**
     * IDEA 2026.2 (262) deprecated the default implementation of
     * `FileEditor.getFile()`: an editor that does not override it makes the
     * platform log a SEVERE on every EditorChange event and pass `null` to
     * the message bus ("PiBrowserFileEditor getFile() returned null").
     * The preview file is known at construction time, so hand it back.
     */
    override fun getFile(): VirtualFile = file

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
