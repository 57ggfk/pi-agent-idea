package dev.pi.agent.browser

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Spec 048 T004: the browser renders untrusted sites; their query strings
 * (session tokens of other services) and console output never reach idea.log
 * verbatim. Hard constraint 8 of the spec.
 */
class LogSafeTest {

    @Test
    fun `query and fragment are stripped`() {
        assertEquals("https://a.b/path", LogSafe.url("https://a.b/path?token=secret#frag"))
        assertEquals("https://a.b/path", LogSafe.url("https://a.b/path?token=secret"))
    }

    @Test
    fun `host and path survive`() {
        assertEquals("http://127.0.0.1:8771/fps.html", LogSafe.url("http://127.0.0.1:8771/fps.html"))
    }

    @Test
    fun `blank input yields empty`() {
        assertEquals("", LogSafe.url(null))
        assertEquals("", LogSafe.url(""))
    }

    @Test
    fun `long urls are capped`() {
        val long = "http://a.b/" + "x".repeat(500)
        val out = LogSafe.url(long)
        assertTrue(out.length <= 310, "length=${out.length}")
    }

    @Test
    fun `truncate flattens newlines and caps`() {
        val out = LogSafe.truncate("line1\nline2\r\n" + "y".repeat(300))
        assertFalse(out.contains('\n'))
        assertFalse(out.contains('\r'))
        // Marker shows the cut with the omitted count; string ends with ")".
        assertTrue(out.contains("…(+") && out.endsWith(")"))
        assertTrue(out.length < 260)
    }

    @Test
    fun `truncate passthrough for short text`() {
        assertEquals("short", LogSafe.truncate("short"))
        assertEquals("", LogSafe.truncate(null))
    }
}
