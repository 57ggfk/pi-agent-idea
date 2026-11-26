package dev.pi.agent.toolwindow

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 063 contract: the tool window may rebuild itself at most once per gap.
 *
 * The 061 build recreated the content 11 times in 12 seconds while the IDE
 * was shutting down, each time spawning a fresh JCEF browser. The guard is
 * what keeps that from turning into a renderer storm.
 */
class AutoRecreatePolicyTest {

    @Test
    fun `a disposing project never auto-recreates`() {
        assertFalse(
            PiAgentToolWindowFactory.autoRecreateAllowed(true, 1_000, 0, 5_000),
        )
    }

    @Test
    fun `the first auto-recreate is always allowed`() {
        assertTrue(
            PiAgentToolWindowFactory.autoRecreateAllowed(false, 1_000, 0, 5_000),
        )
    }

    @Test
    fun `a second auto-recreate inside the gap is skipped`() {
        assertFalse(
            PiAgentToolWindowFactory.autoRecreateAllowed(false, 1_000, 900, 5_000),
        )
    }

    @Test
    fun `a later auto-recreate is allowed again`() {
        assertTrue(
            PiAgentToolWindowFactory.autoRecreateAllowed(false, 6_000, 900, 5_000),
        )
    }
}
