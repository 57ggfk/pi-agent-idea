package dev.pi.agent.bridge

import dev.pi.agent.bridge.VfsRefresh.InFlightToolArgs
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Issue #9 (spec 20261127-214747): the tool arguments of a call in flight.
 *
 * pi sends the arguments with the START of a tool call, not with its END, so
 * the plugin has to hold on to them until the call finishes. Two properties
 * matter, and both are invisible in the happy path:
 *
 *  - the arguments of a call that is still running must still be there when
 *    its END arrives (that is what keeps an edit from escalating to a
 *    whole-project refresh),
 *  - when more calls are in flight than the cap allows, the OLDEST one is
 *    dropped. Dropping an arbitrary one would break the first property for
 *    that call.
 */
class Issue9ToolArgsTrackerTest {

    /** One JSON argument object — built, not parsed, so no escaping is needed. */
    private fun args(vararg pairs: Pair<String, String>): JsonObject =
        buildJsonObject { pairs.forEach { (k, v) -> put(k, v) } }

    /** The path a tracked call named. */
    private fun pathOf(args: JsonObject?): String? = args?.get("path")?.jsonPrimitive?.content

    @Test
    fun `the arguments are there when the call ends`() {
        val tracker = InFlightToolArgs()
        tracker.remember("call-1", args("path" to "src/Main.java"))

        val taken = tracker.take("call-1")

        assertEquals("src/Main.java", pathOf(taken))
        assertEquals(0, tracker.size())
    }

    @Test
    fun `an unknown call has no arguments`() {
        assertNull(InFlightToolArgs().take("never-seen"))
    }

    @Test
    fun `a call without arguments is remembered and released`() {
        val tracker = InFlightToolArgs()
        tracker.remember("call-1", null)

        assertEquals(1, tracker.size())
        assertNull(tracker.take("call-1"))
        assertEquals(0, tracker.size())
    }

    @Test
    fun `the oldest call is dropped first when the cap is reached`() {
        val tracker = InFlightToolArgs(maxEntries = 3)
        tracker.remember("oldest", args("path" to "a"))
        tracker.remember("middle", args("path" to "b"))
        tracker.remember("newest", args("path" to "c"))

        tracker.remember("overflow", args("path" to "d"))

        assertEquals(3, tracker.size())
        // The oldest went first — the two fresh ones are still there.
        assertNull(tracker.take("oldest"))
        assertEquals("b", pathOf(tracker.take("middle")))
        assertEquals("c", pathOf(tracker.take("newest")))
    }

    @Test
    fun `a call that ended is not the one dropped later on`() {
        // The call that finished is no longer in flight, so the tracker
        // released it already — it must not be what gets evicted.
        val tracker = InFlightToolArgs(maxEntries = 2)
        tracker.remember("done", args("path" to "a"))
        tracker.take("done")
        tracker.remember("live-1", args("path" to "b"))
        tracker.remember("live-2", args("path" to "c"))
        tracker.remember("live-3", args("path" to "d"))

        // The finished call is gone, and the OLDEST live one is dropped —
        // not the newest.
        assertNull(tracker.take("done"))
        assertNull(tracker.take("live-1"))
        assertEquals("c", pathOf(tracker.take("live-2")))
        assertEquals("d", pathOf(tracker.take("live-3")))
    }

    @Test
    fun `the cap is respected with many calls in flight`() {
        val tracker = InFlightToolArgs(maxEntries = 8)
        for (i in 0 until 50) tracker.remember("call-" + i, args("path" to "p" + i))

        assertEquals(8, tracker.size())
        // The newest survive; the oldest are gone.
        assertNull(tracker.take("call-0"))
        assertEquals("p49", pathOf(tracker.take("call-49")))
    }
}
