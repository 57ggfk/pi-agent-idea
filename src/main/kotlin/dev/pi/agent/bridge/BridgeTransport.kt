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
        val deadline = System.currentTimeMillis() + timeoutMs
        lock.lock()
        try {
            while (true) {
                val ready = buffer.filter { it.seq > cursor }
                if (ready.isNotEmpty()) return ready
                val remaining = deadline - System.currentTimeMillis()
                if (remaining <= 0) return emptyList()
                condition.await(remaining, TimeUnit.MILLISECONDS)
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

    companion object {
        private const val BUFFER_LIMIT = 2000
    }
}
