package dev.pi.agent.browser

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Transition-table lock (spec 048 T001). The table is small on purpose; every
 * row here is a promise the carriers rely on (error card on FAILED, rebuild
 * on CRASHED, no regression from stale LoadEnd).
 */
class PiBrowserStateTest {

    private val allStates = PiBrowserState.entries

    @Test
    fun `navigate always leads to loading`() {
        for (s in allStates) {
            assertEquals(PiBrowserState.LOADING, PiBrowserStateMachine.transition(s, PiBrowserEvent.Navigate("http://x")), "from $s")
        }
    }

    @Test
    fun `loadEnd only from loading`() {
        assertEquals(PiBrowserState.LOADED, PiBrowserStateMachine.transition(PiBrowserState.LOADING, PiBrowserEvent.LoadEnd))
        // Stale LoadEnd (old frame finishing after the user navigated on) must
        // not regress the state.
        for (s in allStates - PiBrowserState.LOADING) {
            assertNull(PiBrowserStateMachine.transition(s, PiBrowserEvent.LoadEnd), "from $s")
        }
    }

    @Test
    fun `loadError fails from loading, loaded, failed only`() {
        val err = PiBrowserEvent.LoadError("ERR_NAME_NOT_RESOLVED", "no such host")
        for (s in listOf(PiBrowserState.LOADING, PiBrowserState.LOADED, PiBrowserState.FAILED)) {
            assertEquals(PiBrowserState.FAILED, PiBrowserStateMachine.transition(s, err), "from $s")
        }
        for (s in listOf(PiBrowserState.IDLE, PiBrowserState.CRASHED)) {
            assertNull(PiBrowserStateMachine.transition(s, err), "from $s")
        }
    }

    @Test
    fun `crash from every live state but idle`() {
        val crash = PiBrowserEvent.RenderProcessGone("TERM_STATUS")
        for (s in allStates - PiBrowserState.IDLE) {
            assertEquals(PiBrowserState.CRASHED, PiBrowserStateMachine.transition(s, crash), "from $s")
        }
        assertNull(PiBrowserStateMachine.transition(PiBrowserState.IDLE, crash))
    }

    @Test
    fun `rebuilt only from crashed`() {
        assertEquals(PiBrowserState.IDLE, PiBrowserStateMachine.transition(PiBrowserState.CRASHED, PiBrowserEvent.Rebuilt))
        for (s in allStates - PiBrowserState.CRASHED) {
            assertNull(PiBrowserStateMachine.transition(s, PiBrowserEvent.Rebuilt), "from $s")
        }
    }
}
