package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * 068 页签寻址: the agent-facing tab id vocabulary. Tool-window tabs are
 * `t<n>`, editor previews are `e<n>`; the codec validates the format and the
 * manager hands ids out of a per-instance monotonic sequence that never
 * reuses a number (a closed tab's id stays dead — the model can never hit a
 * recycled tab by an old address).
 */
class BrowserTabIdsTest {

    @Test
    fun `valid ids are t or e followed by a positive integer`() {
        for (id in listOf("t1", "t2", "t9", "t10", "t123", "e1", "e2", "e12")) {
            assertTrue(BrowserTabIds.isValid(id), "id=$id must be valid")
        }
    }

    @Test
    fun `malformed ids fail the format check`() {
        // The codec turns these into a model-readable error; the id EXISTING
        // is a runtime question (panelById) and never reaches this regex.
        for (id in listOf("t0", "x1", "T1", "E2", "tab", "editor", "t", "e", "t01", "e0", "1t", "t1 ", " t1", "t1.5", "")) {
            assertFalse(BrowserTabIds.isValid(id), "id='$id' must be invalid")
        }
    }

    @Test
    fun `pattern is the locked wire format`() {
        assertEquals("^[te][1-9][0-9]*$", BrowserTabIds.PATTERN)
    }

    @Test
    fun `format prefixes tool window tabs with t and editor previews with e`() {
        assertEquals("t1", BrowserTabIds.format(BrowserCarrier.TOOLWINDOW, 1))
        assertEquals("e1", BrowserTabIds.format(BrowserCarrier.EDITOR, 1))
        assertEquals("t42", BrowserTabIds.format(BrowserCarrier.TOOLWINDOW, 42))
        assertEquals("e42", BrowserTabIds.format(BrowserCarrier.EDITOR, 42))
    }

    @Test
    fun `sequence is monotonic across carriers and never reuses a number`() {
        val seq = BrowserTabIdSequence()
        // ONE shared counter per manager instance: t1, then e2, then t3 —
        // the number identifies the manager's lifetime, not the carrier.
        assertEquals("t1", seq.next(BrowserCarrier.TOOLWINDOW))
        assertEquals("e2", seq.next(BrowserCarrier.EDITOR))
        assertEquals("t3", seq.next(BrowserCarrier.TOOLWINDOW))
        assertEquals("e4", seq.next(BrowserCarrier.EDITOR))
    }
}
