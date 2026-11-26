package dev.pi.agent.browser

import com.intellij.openapi.fileTypes.UnknownFileType
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile

/**
 * In-memory handle for the editor-form preview (spec 060 T019, US9 D-track).
 * The tab is a [LightVirtualFile] carrying two userData values: the marker
 * that makes [PiBrowserEditorProvider] accept it, and the URL the editor
 * loads on creation — a `/preview/<token>` route OR (066 变更 1/3, via
 * [PiBrowserEditorProvider.openUrlInEditor] and the actions) a direct
 * `file:///` URL. Nothing is persisted — closing the IDE loses the tab,
 * which is fine for a preview.
 *
 * 066 round 2: the file type is UNKNOWN (was PlainText). The platform pairs
 * text files with a text editor + our browser editor, and the resulting
 * 「文本 | 浏览器」 switcher showed an EMPTY text view (the LightVirtualFile
 * carries no content) — pure noise the user flagged. Unknown files get no
 * text editor, so only our browser editor remains.
 */
object PiBrowserPreviewFiles {

    private val MARKER = Key.create<Boolean>("pi.browser.preview.marker")
    private val URL_KEY = Key.create<String>("pi.browser.preview.url")

    fun create(pageName: String, previewUrl: String): LightVirtualFile {
        // The file is a tab handle, its content is rendered by our FileEditor;
        // the unknown type keeps the platform's text editor out of the tab.
        val file = LightVirtualFile("pi-preview: $pageName", UnknownFileType.INSTANCE, "")
        file.putUserData(MARKER, true)
        file.putUserData(URL_KEY, previewUrl)
        return file
    }

    fun isPreview(file: VirtualFile): Boolean = file.getUserData(MARKER) == true

    fun urlOf(file: VirtualFile): String? = file.getUserData(URL_KEY)
}
