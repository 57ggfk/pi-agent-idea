package dev.pi.agent.browser

import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile

/**
 * In-memory handle for the editor-form preview (spec 048 T019, US9 D-track).
 * The tab is a [LightVirtualFile] carrying two userData values: the marker
 * that makes [PiBrowserEditorProvider] accept it, and the URL the editor
 * loads on creation — a `/preview/<token>` route OR (054 变更 1/3, via
 * [PiBrowserEditorProvider.openUrlInEditor] and the actions) a direct
 * `file:///` URL. Nothing is persisted — closing the IDE loses the tab,
 * which is fine for a preview.
 */
object PiBrowserPreviewFiles {

    private val MARKER = Key.create<Boolean>("pi.browser.preview.marker")
    private val URL_KEY = Key.create<String>("pi.browser.preview.url")

    fun create(pageName: String, previewUrl: String): LightVirtualFile {
        // Plain text file type (041 precedent): the file is a tab handle, its
        // content is rendered by our FileEditor — the type only picks the icon.
        val file = LightVirtualFile("pi-preview: $pageName", PlainTextFileType.INSTANCE, "")
        file.putUserData(MARKER, true)
        file.putUserData(URL_KEY, previewUrl)
        return file
    }

    fun isPreview(file: VirtualFile): Boolean = file.getUserData(MARKER) == true

    fun urlOf(file: VirtualFile): String? = file.getUserData(URL_KEY)
}
