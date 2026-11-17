package dev.pi.agent.toolwindow

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 046 FR-003: instance ids are allocated from the REAL Content tabs. The
 * allocator is extracted from the tool window factory as a pure function —
 * the platform-dependent parts (ContentManager enumeration, rebuild) are
 * verified on the real machine (run report 046-F3).
 */
class InstanceIdsTest {

    @Test
    fun `empty tool window allocates instance 1`() {
        assertEquals(1, PiAgentToolWindowFactory.smallestUnusedId(emptySet()))
    }

    @Test
    fun `used ids are skipped and the smallest gap wins`() {
        assertEquals(2, PiAgentToolWindowFactory.smallestUnusedId(setOf(1)))
        assertEquals(1, PiAgentToolWindowFactory.smallestUnusedId(setOf(2, 3)))
        assertEquals(3, PiAgentToolWindowFactory.smallestUnusedId(setOf(1, 2, 4)))
    }

    @Test
    fun `full tool window allocates past the last instance`() {
        assertEquals(5, PiAgentToolWindowFactory.smallestUnusedId(setOf(1, 2, 3, 4)))
    }
}
