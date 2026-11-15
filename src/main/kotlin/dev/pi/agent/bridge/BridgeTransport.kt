package dev.pi.agent.bridge

import kotlinx.serialization.json.JsonObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock

/**
 * Per-project event buffer between the plugin and the web frontend.
 *
 * Each project's [BridgeService] owns one instance, so multiple IDE windows
 * never share an event stream: the frontend long-polls its own project's
 * transport via a token-bound route (see LocalUiServer).
 *
 * The frontend long-polls `GET /bridge/poll?cursor=N`; every pushed record
 * (pi session events, connection state, command responses) is buffered here
 * with a monotonically increasing sequence and delivered in order.
 *
 * 019 (multi-instance): the buffer is **bucketed per instance id** — each
 * tool-window Content runs its own SPA with its own cursor, and cursors only
 * advance inside their own bucket. Instance 1 is the pre-019 default, so
 * single-instance projects behave exactly as before.
 */
class BridgeTransport {

    class Entry(val seq: Long, val record: JsonObject)

    /** One instance's buffer: its own sequence and deque. */
    private class Bucket {
        val seq = AtomicLong(0)
        val buffer = ConcurrentLinkedDeque<Entry>()
        val lock = ReentrantLock()
        val condition = lock.newCondition()
        /** nanoTime of the last `/bridge/poll` for this instance, or 0. */
        val lastPollAt = AtomicLong(0)
    }

    private val buckets = ConcurrentHashMap<Int, Bucket>()

    private fun bucket(instanceId: Int): Bucket = buckets.computeIfAbsent(instanceId) { Bucket() }

    /** Drops a bucket when its instance closes (019 D3 — no unbounded growth). */
    fun clearInstance(instanceId: Int) {
        buckets.remove(instanceId)?.let { b ->
            b.lock.lock()
            try {
                b.buffer.clear()
                b.condition.signalAll()
            } finally {
                b.lock.unlock()
            }
        }
    }

    /** Appends a record to [instanceId]'s bucket and wakes up its pollers. */
    fun push(record: JsonObject, instanceId: Int = 1): Long {
        val b = bucket(instanceId)
        val entry = Entry(b.seq.incrementAndGet(), record)
        b.lock.lock()
        try {
            b.buffer.addLast(entry)
            while (b.buffer.size > BUFFER_LIMIT) {
                b.buffer.pollFirst()
            }
            b.condition.signalAll()
        } finally {
            b.lock.unlock()
        }
        return entry.seq
    }

    /** Latest sequence for [instanceId] (0 when nothing was pushed yet). */
    fun currentSeq(instanceId: Int = 1): Long = bucket(instanceId).seq.get()

    /** Lowest buffered sequence for [instanceId]; earlier cursors mean drops. */
    fun oldestSeq(instanceId: Int = 1): Long = bucket(instanceId).buffer.peekFirst()?.seq ?: (bucket(instanceId).seq.get() + 1)

    /**
     * Blocks until [instanceId]'s bucket has a record with sequence > [cursor]
     * or [timeoutMs] elapses. Returns the records in order (possibly empty).
     */
    fun pollAfter(cursor: Long, timeoutMs: Long, instanceId: Int = 1): List<Entry> {
        val b = bucket(instanceId)
        // Recorded on arrival, not on return: a request that parks the full
        // 20s still proves the page is alive and running.
        b.lastPollAt.set(System.nanoTime())
        // nanoTime, not currentTimeMillis: a wall-clock correction (NTP step,
        // the user fixing the system clock) while a poll is parked would
        // otherwise stretch the wait by the size of the jump — a request that
        // was meant to last 20s could sleep for an hour and the panel would
        // look frozen until the next event arrived.
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        b.lock.lock()
        try {
            while (true) {
                val ready = b.buffer.filter { it.seq > cursor }
                if (ready.isNotEmpty()) return ready
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0) return emptyList()
                b.condition.await(remaining, TimeUnit.NANOSECONDS)
            }
        } finally {
            b.lock.unlock()
        }
    }

    /** Test/diagnostic helper: clears one instance's bucket. */
    fun clear(instanceId: Int = 1) {
        val b = bucket(instanceId)
        b.lock.lock()
        try {
            b.buffer.clear()
            b.condition.signalAll()
        } finally {
            b.lock.unlock()
        }
    }

    /**
     * Milliseconds since [instanceId]'s frontend last polled, or
     * [Long.MAX_VALUE] when it never has. Per-instance on purpose (019 D6):
     * A's page polling must not make B's health check think B is alive.
     */
    fun sinceLastPollMs(instanceId: Int = 1): Long {
        val at = bucket(instanceId).lastPollAt.get()
        if (at == 0L) return Long.MAX_VALUE
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - at)
    }

    companion object {
        private const val BUFFER_LIMIT = 2000
    }
}
