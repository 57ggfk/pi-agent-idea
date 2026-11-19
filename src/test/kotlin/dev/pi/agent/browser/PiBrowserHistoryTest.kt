package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.Test

/** F-201: the address-bar history LRU — dedup, recency order, hard cap 20. */
class PiBrowserHistoryTest {

    @Test
    fun `most recent first with dedup`() {
        val history = PiBrowserHistory()
        history.add("http://127.0.0.1:8931/")
        history.add("http://127.0.0.1:8932/")
        history.add("http://127.0.0.1:8931/") // revisit moves to front
        assertEquals(
            listOf("http://127.0.0.1:8931/", "http://127.0.0.1:8932/"),
            history.entries(),
        )
    }

    @Test
    fun `cap at twenty entries`() {
        val history = PiBrowserHistory()
        for (p in 1..25) history.add("http://127.0.0.1:$p/")
        val entries = history.entries()
        assertEquals(20, entries.size)
        assertTrue(entries.first() == "http://127.0.0.1:25/")
        assertTrue(entries.last() == "http://127.0.0.1:6/")
    }

    @Test
    fun `blank urls are refused and clear empties`() {
        val history = PiBrowserHistory()
        history.add("   ")
        assertTrue(history.entries().isEmpty())
        history.add("http://a/")
        history.clear()
        assertTrue(history.entries().isEmpty())
    }
}
