package dev.pi.agent.toolwindow

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Issue #12: closing a pi instance must always ask first.
 *
 * The old guard only asked while a run was in flight
 * (`BridgeService.isStreaming`), so an idle instance was closed without a
 * word and the conversation in it was lost.
 *
 * The decision under test is the pure part of the guard: what the user's
 * answer means. "No" keeps the instance (the tab is rebuilt with the same
 * id), "Yes" stops the instance.
 */
class Issue12CloseConfirmTest {

    @Test
    fun `the confirmation is asked for an idle instance too`() {
        // The guard asks unconditionally — there is no "only while running"
        // branch left, so the question is always asked.
        assertTrue(PiAgentToolWindowFactory.asksForCloseConfirmation())
    }

    @Test
    fun `no keeps the instance and rebuilds the tab with the same id`() {
        assertEquals(
            PiAgentToolWindowFactory.CloseOutcome.KEEP_INSTANCE,
            PiAgentToolWindowFactory.closeOutcome(PiAgentToolWindowFactory.ANSWER_NO),
        )
    }

    @Test
    fun `yes stops the instance`() {
        assertEquals(
            PiAgentToolWindowFactory.CloseOutcome.STOP_INSTANCE,
            PiAgentToolWindowFactory.closeOutcome(PiAgentToolWindowFactory.ANSWER_YES),
        )
    }

    @Test
    fun `the answer codes match the platform dialog constants`() {
        // Messages.YES == 0 and Messages.NO == 1 (MessageConstants). The
        // guard must not disagree with the dialog it reads the answer from.
        assertEquals(0, PiAgentToolWindowFactory.ANSWER_YES)
        assertEquals(1, PiAgentToolWindowFactory.ANSWER_NO)
    }
}
