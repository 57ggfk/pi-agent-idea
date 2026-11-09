package dev.pi.agent.bridge

import kotlinx.serialization.json.JsonObject
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
 */
class BridgeTransport {

    class Entry(val seq: Long, val record: JsonObject)

    private val seq = AtomicLong(0)
    private val buffer = ConcurrentLinkedDeque<Entry>()
    private val lock = ReentrantLock()
    private val condition = lock.newCondition()

    /**
     * nanoTime of the last `/bridge/poll` that reached this project, or 0.
     * The page polls for its whole life, so "no poll for a while" is the one
     * reliable sign that the embedded browser stopped running the SPA — a dead
     * renderer is invisible from Swing (see PiAgentPanel's health watch).
     */
    private val lastPollAt = AtomicLong(0)

    /** Appends a record and wakes up pollers. Returns the assigned sequence. */
    fun push(record: JsonObject): Long {
        val entry = Entry(seq.incrementAndGet(), record)
        lock.lock()
        try {
            buffer.addLast(entry)
            while (buffer.size > BUFFER_LIMIT) {
                buffer.pollFirst()
            }
            condition.signalAll()
        } finally {
            lock.unlock()
        }
        return entry.seq
    }

    /** Latest sequence (0 when nothing was pushed yet). */
    fun currentSeq(): Long = seq.get()

    /** Lowest sequence still buffered; earlier cursors mean dropped events. */
    fun oldestSeq(): Long = buffer.peekFirst()?.seq ?: (seq.get() + 1)

    /**
     * Blocks until a record with sequence > [cursor] exists or [timeoutMs] elapses.
     * Returns the records in order (possibly empty on timeout).
     */
    fun pollAfter(cursor: Long, timeoutMs: Long): List<Entry> {
        // Recorded on arrival, not on return: a request that parks the full
        // 20s still proves the page is alive and running.
        lastPollAt.set(System.nanoTime())
        // nanoTime, not currentTimeMillis: a wall-clock correction (NTP step,
        // the user fixing the system clock) while a poll is parked would
        // otherwise stretch the wait by the size of the jump — a request that
        // was meant to last 20s could sleep for an hour and the panel would
        // look frozen until the next event arrived.
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        lock.lock()
        try {
            while (true) {
                val ready = buffer.filter { it.seq > cursor }
                if (ready.isNotEmpty()) return ready
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0) return emptyList()
                condition.await(remaining, TimeUnit.NANOSECONDS)
            }
        } finally {
            lock.unlock()
        }
    }

    /** Test/diagnostic helper. */
    fun clear() {
        lock.lock()
        try {
            buffer.clear()
            condition.signalAll()
        } finally {
            lock.unlock()
        }
    }

    /**
     * Milliseconds since the frontend last polled, or [Long.MAX_VALUE] when it
     * never has (a project whose panel was never opened, or one that never
     * reached this window's token).
     */
    fun sinceLastPollMs(): Long {
        val at = lastPollAt.get()
        if (at == 0L) return Long.MAX_VALUE
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - at)
    }

    companion object {
        private const val BUFFER_LIMIT = 2000
    }
}
