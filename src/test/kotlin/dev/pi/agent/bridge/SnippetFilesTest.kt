package dev.pi.agent.bridge

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

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
        assertEquals("shell", SnippetFiles.ideLanguageId("bash"))
        assertEquals("JSON", SnippetFiles.ideLanguageId("json"))
        assertEquals("Markdown", SnippetFiles.ideLanguageId("md"))
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
        // A clean unknown id keeps itself as the extension; anything unusable
        // falls back to txt so the name is always a valid file name.
        assertEquals("foobar", SnippetFiles.extensionFor("foobar"))
        assertEquals("txt", SnippetFiles.extensionFor("weird lang"))
        assertEquals("txt", SnippetFiles.extensionFor(""))
        assertEquals("kt", SnippetFiles.extensionFor("Kotlin"))
    }
}
