package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * Spec 049 B1: the agent readback is a bounded, read-only snapshot. These
 * tests lock the sanitizer: control characters never survive, length never
 * exceeds the cap, and malformed JS responses degrade to failure snapshots
 * instead of exceptions.
 */
class PageSnapshotSanitizerTest {

    @Test
    fun `clean text strips control characters but keeps newline and tab`() {
        assertEquals("abc\nb\tc", PageSnapshotSanitizer.cleanText("a\u0000b\u0007c\nb\tc"))
        // ESC (C0) is stripped; the rest of the ANSI sequence is plain text.
        assertEquals("line1[0m\nline2", PageSnapshotSanitizer.cleanText("line1\u001B[0m\nline2"))
        assertEquals("tab\there", PageSnapshotSanitizer.cleanText("tab\there"))
    }

    @Test
    fun `clean text caps length at the limit`() {
        val big = "x".repeat(5000)
        assertEquals(PageSnapshotSanitizer.MAX_TEXT_CHARS, PageSnapshotSanitizer.cleanText(big).length)
        assertEquals(50, PageSnapshotSanitizer.cleanText(big, 50).length)
    }

    @Test
    fun `clean text handles empty`() {
        assertEquals("", PageSnapshotSanitizer.cleanText(""))
    }

    @Test
    fun `valid js response parses into an ok snapshot`() {
        val raw = """{"title":"Vite + React","ready":"complete","text":"hello world"}"""
        val snap = PageSnapshotSanitizer.fromJs(raw, "http://127.0.0.1:5173/", "cached")
        assertTrue(snap.ok)
        assertEquals("Vite + React", snap.title)
        assertEquals("complete", snap.readyState)
        assertEquals("hello world", snap.text)
        assertEquals("http://127.0.0.1:5173/", snap.url)
    }

    @Test
    fun `js-side error becomes a failure snapshot with the reason`() {
        val raw = """{"title":"","ready":"error","text":"","error":"document is not defined"}"""
        val snap = PageSnapshotSanitizer.fromJs(raw, "http://x/", "")
        assertFalse(snap.ok)
        assertEquals("document is not defined", snap.reason)
    }

    @Test
    fun `malformed response degrades instead of throwing`() {
        // {"title":123} deliberately absent: a JSON number coerces to "123"
        // via jsonPrimitive.content — legal, not an error case.
        for (raw in listOf(null, "", "not json", """{"text": {"nested": true}}""")) {
            val snap = PageSnapshotSanitizer.fromJs(raw, "http://x/", "t")
            assertFalse(snap.ok, "raw=$raw")
            assertTrue(snap.reason != null)
        }
    }

    @Test
    fun `read script embeds the inject statement and the text cap`() {
        val script = PageSnapshotSanitizer.buildReadScript("window.cefQuery_1({request: '' + result});")
        assertTrue("window.cefQuery_1" in script)
        assertTrue("document.readyState" in script)
        assertTrue("slice(0, ${PageSnapshotSanitizer.MAX_TEXT_CHARS})" in script)
        // Nothing writable: the script assigns no properties, calls no methods
        // that mutate — a grep-level guarantee for the hard rule 1 revision.
        assertFalse(Regex("\\.(submit|click|focus|write)\\s*\\(").containsMatchIn(script))
    }
}
