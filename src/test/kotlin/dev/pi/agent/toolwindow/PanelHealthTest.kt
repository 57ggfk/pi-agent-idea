package dev.pi.agent.toolwindow

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 063 contract: the Pi Agent tool window must never spin on a dead page.
 *
 * The 061 build rebuilt the embedded browser forever. The silence threshold
 * (90s) was LONGER than the crash-loop window (60s), so every rebuild was the
 * only entry in the window and the "give up" limit could never trip. The
 * panel therefore restarted the browser every 90 seconds for as long as the
 * page stayed dead — a white void with nothing the user could do about it.
 *
 * The budget is now counted in CONSECUTIVE failures, so it cannot be
 * outrun by the silence threshold, and a page that never answers ends on a
 * card with a manual retry instead of an endless restart loop.
 */
class PanelHealthTest {

    @Test
    fun `a poll that arrived after the mount keeps the panel alive`() {
        assertEquals(
            PanelHealthDecision.ALIVE,
            PanelHealth.decide(
                pollAgeSinceMountMs = 4_000,
                mountAgeMs = 30_000,
                consecutiveFailures = 2,
            ),
        )
    }

    @Test
    fun `a page that has not had time to answer yet is pending, not broken`() {
        assertEquals(
            PanelHealthDecision.PENDING,
            PanelHealth.decide(
                pollAgeSinceMountMs = Long.MAX_VALUE,
                mountAgeMs = 5_000,
                consecutiveFailures = 0,
            ),
        )
    }

    @Test
    fun `silence past the threshold rebuilds the browser`() {
        assertEquals(
            PanelHealthDecision.REBUILD,
            PanelHealth.decide(
                pollAgeSinceMountMs = Long.MAX_VALUE,
                mountAgeMs = 95_000,
                consecutiveFailures = 0,
            ),
        )
    }

    @Test
    fun `the rebuild budget is counted in failures, not in wall-clock windows`() {
        // The exact shape of the 061 bug: the window was shorter than the
        // silence threshold, so the counter never reached the limit.
        assertEquals(
            PanelHealthDecision.GIVE_UP,
            PanelHealth.decide(
                pollAgeSinceMountMs = Long.MAX_VALUE,
                mountAgeMs = 95_000,
                consecutiveFailures = PanelHealth.MAX_CONSECUTIVE_FAILURES,
            ),
        )
    }

    @Test
    fun `a poll older than the mount does not count as a live page`() {
        // Only polls made AFTER this mount are evidence that the CURRENT page
        // is running. The previous page's last poll must not keep a dead page
        // looking alive forever.
        assertEquals(
            Long.MAX_VALUE,
            PanelHealth.pollAgeSinceMount(currentPollAgeMs = 120_000, mountAgeMs = 30_000),
        )
    }

    @Test
    fun `a poll newer than the mount counts`() {
        assertEquals(
            2_000,
            PanelHealth.pollAgeSinceMount(currentPollAgeMs = 2_000, mountAgeMs = 30_000),
        )
    }

    @Test
    fun `the first poll after the mount counts even when the page never polled before`() {
        assertEquals(
            5_000,
            PanelHealth.pollAgeSinceMount(currentPollAgeMs = 5_000, mountAgeMs = 10_000),
        )
    }

    @Test
    fun `a page that never polled stays unknown`() {
        assertEquals(
            Long.MAX_VALUE,
            PanelHealth.pollAgeSinceMount(currentPollAgeMs = Long.MAX_VALUE, mountAgeMs = Long.MAX_VALUE),
        )
    }
}
