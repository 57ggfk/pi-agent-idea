package dev.pi.agent.bridge

import dev.pi.agent.bridge.resolveTargetInstance
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Issue #7 (spec 20261127-214745): IDE actions must land in the pi instance
 * the user is looking at, not always in instance 1.
 *
 * The rule (plan.md §2.1):
 *  1. the tool window's selected content is a pi instance → that instance
 *  2. otherwise the pi instance that was selected last → that instance
 *  3. otherwise nothing is determinable → the caller keeps the old
 *     behaviour (instance 1)
 *
 * A closed instance must never be the target: its tab is gone, so its
 * frontend is gone with it and the prompt would be dropped silently.
 */
class Issue7InstanceRoutingTest {

    @Test
    fun `the selected pi instance wins`() {
        assertEquals(2, resolveTargetInstance(selectedId = 2, lastSelectedId = 1, liveIds = setOf(1, 2)))
    }

    @Test
    fun `a browser tab falls back to the pi instance selected last`() {
        assertEquals(3, resolveTargetInstance(selectedId = null, lastSelectedId = 3, liveIds = setOf(1, 3)))
    }

    @Test
    fun `the last selected instance is used when nothing is selected`() {
        assertEquals(2, resolveTargetInstance(selectedId = null, lastSelectedId = 2, liveIds = setOf(1, 2)))
    }

    @Test
    fun `no pi instance at all means the caller falls back to instance 1`() {
        assertNull(resolveTargetInstance(selectedId = null, lastSelectedId = null, liveIds = emptySet()))
    }

    @Test
    fun `a closed instance is never the target`() {
        // Instance 2 was closed: its id must not win, not even as the last
        // selected one — the prompt would go to a frontend that no longer
        // exists.
        assertNull(resolveTargetInstance(selectedId = null, lastSelectedId = 2, liveIds = setOf(1)))
        assertNull(resolveTargetInstance(selectedId = 2, lastSelectedId = 2, liveIds = setOf(1)))
    }

    @Test
    fun `the selected instance wins over the last selected one`() {
        assertEquals(4, resolveTargetInstance(selectedId = 4, lastSelectedId = 2, liveIds = setOf(2, 4)))
    }
}
