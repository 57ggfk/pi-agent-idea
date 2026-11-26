package dev.pi.agent.browser

import com.intellij.openapi.vfs.VirtualFile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * IDEA 2026.2 (262) deprecated the default implementation of
 * `FileEditor.getFile()`: an editor that does not override it makes the
 * platform log a SEVERE on every EditorChange event and hand `null` to the
 * message bus ("dev.pi.agent.browser.PiBrowserFileEditor getFile() returned
 * null"). The 060 editor tab (T019 — "在编辑器中打开") hit exactly that on
 * the real IDE.
 *
 * The editor cannot be instantiated in a unit test — its constructor builds a
 * JBCefBrowser — so the contract is asserted on the class itself: the method
 * must be DECLARED by PiBrowserFileEditor, never inherited from the
 * deprecated platform default.
 */
class PiBrowserEditorProviderTest {

    @Test
    fun `browser file editor declares getFile instead of inheriting the deprecated default`() {
        val declared = PiBrowserFileEditor::class.java.declaredMethods.filter { it.name == "getFile" }
        assertEquals(
            1,
            declared.size,
            "PiBrowserFileEditor must declare getFile() itself — inheriting the platform default " +
                "returns null and logs SEVERE on every EditorChange (IDEA 262)",
        )
        assertEquals(VirtualFile::class.java, declared.first().returnType, "getFile() must return the edited VirtualFile")
    }

    @Test
    fun `getFile is not a synthetic bridge that still routes to the platform default`() {
        val getFile = PiBrowserFileEditor::class.java.declaredMethods.single { it.name == "getFile" }
        assertTrue(
            !getFile.isSynthetic,
            "a synthetic bridge would still call the deprecated default implementation",
        )
    }
}
