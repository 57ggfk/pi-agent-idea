package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * Spec 061 B1: the agent readback is a bounded, read-only snapshot. These
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

    // ---- 065 B2: structured read (selector element excerpt) ----

    @Test
    fun `read script without selector stays byte-for-byte identical`() {
        val inject = "window.cefQuery_1({request: '' + result});"
        val expected = """(function() {
  var result;
  try {
    result = JSON.stringify({
      title: String(document.title || ''),
      ready: String(document.readyState || ''),
      text: String((document.body && document.body.innerText) || '').slice(0, ${PageSnapshotSanitizer.MAX_TEXT_CHARS})
    });
  } catch (e) {
    result = JSON.stringify({ title: '', ready: 'error', text: '', error: String((e && e.message) || e) });
  }
  $inject
})()"""
        assertEquals(expected, PageSnapshotSanitizer.buildReadScript(inject))
        assertEquals(expected, PageSnapshotSanitizer.buildReadScript(inject, selector = null, format = null))
    }

    @Test
    fun `read script with selector queries the element and reports misses`() {
        val script = PageSnapshotSanitizer.buildReadScript("INJ", selector = "#root > .item", format = "html")
        assertTrue("document.querySelector" in script)
        assertTrue("\"#root > .item\"" in script)
        assertTrue("outerHTML" in script)
        assertTrue("no element matches selector" in script)
        assertTrue("INJ" in script)
        assertTrue("slice(0, ${PageSnapshotSanitizer.MAX_TEXT_CHARS})" in script)
        // Still read-only: no DOM writes even in the selector branch.
        assertFalse(Regex("\\.(submit|click|focus|write)\\s*\\(").containsMatchIn(script))
    }

    @Test
    fun `read script text format excerpts innerText and defaults without format`() {
        val textScript = PageSnapshotSanitizer.buildReadScript("INJ", selector = "table", format = "text")
        assertTrue("innerText" in textScript)
        assertFalse("outerHTML" in textScript)
        // Absent format falls back to the text excerpt (the pre-065 behavior).
        val defaultScript = PageSnapshotSanitizer.buildReadScript("INJ", selector = "table")
        assertTrue("innerText" in defaultScript)
        assertFalse("outerHTML" in defaultScript)
    }

    @Test
    fun `selector is embedded as an escaped js string literal`() {
        val sneaky = PageSnapshotSanitizer.buildReadScript("INJ", selector = """a"; alert(1); p[onclick="x"]""")
        // The quote that would close the literal is escaped, so the payload
        // stays inert string content of the selector literal.
        assertTrue("""a\"; alert(1); p[onclick=\"x\"]""" in sneaky)
    }

    @Test
    fun `html excerpt passes the same clean-and-cap path on the way back`() {
        val raw = """{"title":"t","ready":"complete","text":"<div>a\u0000b</div>${"x".repeat(4000)}"}"""
        val snap = PageSnapshotSanitizer.fromJs(raw, "http://x/", "")
        assertTrue(snap.ok)
        assertFalse(snap.text.contains('\u0000'))
        assertEquals(PageSnapshotSanitizer.MAX_TEXT_CHARS, snap.text.length)
    }
}
