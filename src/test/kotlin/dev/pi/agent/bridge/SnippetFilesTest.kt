package dev.pi.agent.bridge

import com.intellij.openapi.fileTypes.UnknownFileType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** 041 FR-004: fence language id → IDE language id mapping + extension pick. */
class SnippetFilesTest {

    @Test
    fun `common fence ids map to IDE language ids`() {
        assertEquals("JavaScript", SnippetFiles.ideLanguageId("js"))
        assertEquals("JavaScript", SnippetFiles.ideLanguageId("jsx"))
        assertEquals("TypeScript", SnippetFiles.ideLanguageId("ts"))
        assertEquals("Python", SnippetFiles.ideLanguageId("py"))
        assertEquals("kotlin", SnippetFiles.ideLanguageId("kt"))
        assertEquals("JAVA", SnippetFiles.ideLanguageId("java"))
        assertEquals("JSON", SnippetFiles.ideLanguageId("json"))
        assertEquals("Markdown", SnippetFiles.ideLanguageId("md"))
        // 041 #10: style languages the CSS plugin registers with their own
        // ids; the fence id alone never matched them before.
        assertEquals("SCSS", SnippetFiles.ideLanguageId("scss"))
        assertEquals("SASS", SnippetFiles.ideLanguageId("sass"))
        assertEquals("LESS", SnippetFiles.ideLanguageId("less"))
        assertEquals("LESS", SnippetFiles.ideLanguageId("LESS"))
    }

    @Test
    fun `shell ids map to the IDE language id that actually exists`() {
        // "shell" was never a language id: the IDE calls it "Shell Script",
        // so every shell block fell through to the extension lookup and
        // then to plain text.
        assertEquals("Shell Script", SnippetFiles.ideLanguageId("sh"))
        assertEquals("Shell Script", SnippetFiles.ideLanguageId("bash"))
        assertEquals("Shell Script", SnippetFiles.ideLanguageId("zsh"))
        assertEquals("Shell Script", SnippetFiles.ideLanguageId("shell"))
    }

    @Test
    fun `mapping is case-insensitive`() {
        assertEquals("Python", SnippetFiles.ideLanguageId("PY"))
        assertEquals("JSON", SnippetFiles.ideLanguageId("Json"))
    }

    @Test
    fun `unknown and blank ids have no mapping (degrade to plain text)`() {
        assertNull(SnippetFiles.ideLanguageId("foobar"))
        assertNull(SnippetFiles.ideLanguageId(""))
    }

    @Test
    fun `extensions cover known ids and sanitize unknown ones`() {
        assertEquals("ts", SnippetFiles.extensionFor("ts"))
        assertEquals("rs", SnippetFiles.extensionFor("rust"))
        assertEquals("sh", SnippetFiles.extensionFor("bash"))
        assertEquals("go", SnippetFiles.extensionFor("golang"))
        // A clean unknown id keeps itself as the extension; anything unusable
        // falls back to txt so the name is always a valid file name.
        assertEquals("foobar", SnippetFiles.extensionFor("foobar"))
        assertEquals("txt", SnippetFiles.extensionFor("weird lang"))
        assertEquals("txt", SnippetFiles.extensionFor(""))
        assertEquals("kt", SnippetFiles.extensionFor("Kotlin"))
    }

    @Test
    fun `the alias id comes first, the raw id is the second chance`() {
        // The raw id is what lets "lua", "dart" or "scala" resolve on their
        // own when the IDE has the plugin — no table entry needed.
        assertEquals(listOf("Shell Script", "bash"), SnippetFiles.languageCandidates("bash"))
        assertEquals(listOf("lua"), SnippetFiles.languageCandidates("lua"))
        assertEquals(listOf("Rust", "rs"), SnippetFiles.languageCandidates("rs"))
        assertEquals(emptyList(), SnippetFiles.languageCandidates(""))
    }

    @Test
    fun `a binary file type is never picked`() {
        // The regression: a fence id the IDE has no type for resolved to
        // FileType.UNKNOWN, which is binary — the IDE opened it with the
        // large-file viewer, which has no focusable component, and closed
        // the tab again at once. The user saw nothing.
        val candidates = listOf("unknown" to true, "plain" to false)
        val picked = SnippetFiles.firstTextual(candidates) { it.second }
        assertEquals("plain", picked?.first)
    }

    @Test
    fun `no textual candidate yields null so the caller falls back to plain text`() {
        val allBinary = listOf("a" to true, "b" to true)
        assertNull(SnippetFiles.firstTextual(allBinary) { it.second })
        assertNull(SnippetFiles.firstTextual(emptyList<String>()) { false })
    }

    @Test
    fun `the platform's unknown file type is binary - the trap this class exists for`() {
        // getFileTypeByExtension answers UnknownFileType.INSTANCE for an
        // extension the IDE does not know, and that type is binary — the
        // IDE opens it with the large-file viewer, which has no focusable
        // component, and closes the tab again at once.
        assertTrue(UnknownFileType.INSTANCE.isBinary)
    }
}
