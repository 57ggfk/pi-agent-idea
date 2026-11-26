package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * Spec 065 B2: the scroll script is viewport-only (window.scrollBy, no DOM
 * writes) and its result parses back through the same query channel as the
 * read snapshot. The D4 revision — "read-only DOM + viewport scrolling" —
 * means scrollBy is the ONE mutation this channel performs.
 */
class PageScrollTest {

    @Test
    fun `scroll script moves the viewport and reports back through the inject channel`() {
        val script = PageScroll.buildScrollScript("INJ_STMT", "down", 500)
        assertTrue("window.scrollBy(0, 500)" in script)
        assertTrue("window.scrollY" in script)
        assertTrue("document.documentElement.scrollHeight" in script)
        assertTrue("window.innerHeight" in script)
        assertTrue("INJ_STMT" in script)
        // Routing tag: the kernel's single query channel dispatches on the
        // JSON.stringify output ("kind":"scroll"); the source literal is what
        // the script text carries.
        assertTrue("kind: 'scroll'" in script)
    }

    @Test
    fun `up direction scrolls negative`() {
        val script = PageScroll.buildScrollScript("INJ", "up", 500)
        assertTrue("window.scrollBy(0, -500)" in script)
        assertFalse("window.scrollBy(0, 500)" in script)
    }

    @Test
    fun `script is viewport-only and never touches the DOM`() {
        val script = PageScroll.buildScrollScript("INJ", "down", 500)
        assertFalse("querySelector" in script)
        assertFalse(Regex("\\.(innerHTML|outerHTML|innerText|textContent|value)\\s*=").containsMatchIn(script))
        assertFalse(Regex("\\.(submit|click|focus|write)\\s*\\(").containsMatchIn(script))
        // No tokens, no bridge references — 061 D4 continuation.
        assertFalse("token" in script.lowercase())
        assertFalse("bridge" in script.lowercase())
    }

    @Test
    fun `script degrades to an error field on page-side exceptions`() {
        val script = PageScroll.buildScrollScript("INJ", "down", 500)
        assertTrue("error: String((e && e.message) || e)" in script)
    }

    @Test
    fun `amount and direction are clamped defensively in the builder`() {
        val script = PageScroll.buildScrollScript("INJ", "DOWN", PageScroll.MAX_SCROLL_PX + 7)
        assertTrue("window.scrollBy(0, ${PageScroll.MAX_SCROLL_PX})" in script)
        // Unknown direction falls back to down (positive), never sideways.
        val weird = PageScroll.buildScrollScript("INJ", "sideways", 300)
        assertTrue("window.scrollBy(0, 300)" in weird)
    }

    @Test
    fun `valid scroll response parses into an ok result`() {
        val raw = """{"kind":"scroll","scrollY":1200,"scrollHeight":8400,"innerHeight":800}"""
        val result = ScrollResult.fromJs(raw)
        assertTrue(result.ok)
        assertEquals(1200, result.scrollY)
        assertEquals(8400, result.scrollHeight)
        assertEquals(800, result.innerHeight)
    }

    @Test
    fun `scroll error degrades to a failure with the reason`() {
        val errored = ScrollResult.fromJs("""{"kind":"scroll","error":"SecurityError: blocked"}""")
        assertFalse(errored.ok)
        assertEquals("SecurityError: blocked", errored.reason)

        for (raw in listOf(null, "", "not json", """{"kind":"read"}""")) {
            val result = ScrollResult.fromJs(raw)
            assertFalse(result.ok, "raw=$raw")
            assertTrue(result.reason != null, "raw=$raw")
        }
    }

    @Test
    fun `failure factories keep the model-readable copy in one place`() {
        assertEquals("browser tab is not open; use open first", ScrollResult.noPage().reason)
        assertEquals("browser renderer is down", ScrollResult.rendererDown().reason)
        assertEquals("browser is still starting", ScrollResult.stillStarting().reason)
        assertEquals("another scroll is still in flight; retry shortly", ScrollResult.inFlight().reason)
        assertEquals(
            "scroll timed out; the page may still be loading or blocked",
            ScrollResult.timedOut().reason,
        )
    }
}
