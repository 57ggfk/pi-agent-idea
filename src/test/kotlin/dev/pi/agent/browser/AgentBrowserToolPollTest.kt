package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * 049: `AgentBrowserTool.open` waits for the browser tab to appear because
 * `PiBrowserManager.open` creates the content asynchronously on the EDT — a
 * one-shot lookup raced it on the real machine and wrongly reported "tool
 * window unavailable" (反向用例 2026-11-19). This locks the poll semantics.
 */
class AgentBrowserToolPollTest {

    @Test
    fun `returns the value immediately when present`() {
        val started = System.currentTimeMillis()
        val v = AgentBrowserTool.pollUntil(1_000) { "panel" }
        assertEquals("panel", v)
        assertTrue(System.currentTimeMillis() - started < 500, "must not burn the whole timeout")
    }

    @Test
    fun `returns null after the timeout when the supplier never yields`() {
        val started = System.currentTimeMillis()
        assertNull(AgentBrowserTool.pollUntil(150, intervalMs = 30) { null })
        assertTrue(System.currentTimeMillis() - started >= 150)
    }

    @Test
    fun `returns as soon as the supplier starts yielding`() {
        var calls = 0
        val v = AgentBrowserTool.pollUntil(2_000, intervalMs = 20) {
            calls++
            if (calls >= 3) "ready" else null
        }
        assertEquals("ready", v)
        assertEquals(3, calls)
    }

    // ---- 053 B2: scroll's model-readable failure copy ----

    @Test
    fun `scroll failure copy covers the empty-tab and timeout paths`() {
        // Empty tab (no browser tool-window panel): same hint read/reload give.
        assertEquals("browser tab is not open; use open first", AgentBrowserTool.NO_TAB_REASON)
        // Kernel-side timeout (completeOnTimeout on the scroll future).
        assertEquals(
            "scroll timed out; the page may still be loading or blocked",
            ScrollResult.timedOut().reason,
        )
    }
}
