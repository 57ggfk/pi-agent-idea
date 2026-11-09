package dev.pi.agent.bridge

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The long-poll contract behind the tool window's event stream.
 *
 * The panel treats "the frontend stopped polling" as its liveness signal
 * (PiAgentPanel's health watch), so `pollAfter` has to be precise about both
 * halves of that contract: it must return buffered events immediately, and it
 * must return within the requested timeout when there is nothing to send.
 */
class BridgeTransportTest {

    private fun record(n: Int) = buildJsonObject { put("n", n) }

    @Test
    fun `buffered events are returned without waiting`() {
        val transport = BridgeTransport()
        transport.push(record(1))
        transport.push(record(2))

        val started = System.nanoTime()
        val entries = transport.pollAfter(0, 5_000)
        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)

        assertEquals(listOf(1L, 2L), entries.map { it.seq })
        assertTrue(elapsedMs < 1_000, "an available batch must not wait ($elapsedMs ms)")
    }

    @Test
    fun `an empty poll returns after the requested timeout`() {
        val transport = BridgeTransport()

        val started = System.nanoTime()
        val entries = transport.pollAfter(0, 150)
        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)

        assertTrue(entries.isEmpty())
        assertTrue(elapsedMs >= 100, "returned before the timeout elapsed ($elapsedMs ms)")
        // Generous ceiling: a loaded CI machine may overshoot, but a wall-clock
        // based deadline could overshoot by hours.
        assertTrue(elapsedMs < 5_000, "waited far longer than requested ($elapsedMs ms)")
    }

    @Test
    fun `a parked poll is woken by a push`() {
        val transport = BridgeTransport()
        val result = CompletableFuture<List<BridgeTransport.Entry>>()
        Thread { result.complete(transport.pollAfter(0, 5_000)) }.apply { isDaemon = true }.start()

        // Let the poller park on the condition before signalling it.
        Thread.sleep(100)
        transport.push(record(7))

        val entries = result.get(3, TimeUnit.SECONDS)
        assertEquals(1, entries.size)
        assertEquals("7", entries.first().record["n"].toString())
    }

    @Test
    fun `silence is reported from the last poll, not from the start`() {
        val transport = BridgeTransport()
        // Never polled: the panel must not think a page it never had died.
        assertEquals(Long.MAX_VALUE, transport.sinceLastPollMs())

        transport.pollAfter(0, 10)
        val since = transport.sinceLastPollMs()
        assertTrue(since in 0..2_000, "age should be near zero right after a poll ($since ms)")
    }
}
