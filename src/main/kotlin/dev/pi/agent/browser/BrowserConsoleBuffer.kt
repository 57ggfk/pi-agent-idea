package dev.pi.agent.browser

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * One captured console line with its buffer-wide monotonic index (053 B3):
 * the index the agent's `since` speaks, and the same index the JSONL sink
 * records.
 */
data class ConsoleEntry(val index: Int, val text: String)

/**
 * One `since(index, limit)` readback: the counters the response reports plus
 * the entries with index > since, oldest first.
 */
data class ConsoleWindow(val total: Int, val dropped: Int, val entries: List<ConsoleEntry>)

/**
 * Bounded buffer of the browser tab's page console output (F-206, 049 P2
 * "console/network 进上下文" made minimal). Events arrive over the DevTools
 * channel that the kernel attaches in reflection (the CefDevToolsClient class
 * does not exist on the 233 floor, so nothing here names it directly).
 *
 * Only error/warning-level lines are kept — the model needs "what went wrong",
 * not a debug firehose. Every line passes [LogSafe.truncate]; nothing from
 * here ever reaches idea.log (048 hard rule 8).
 *
 * 053 B3: accepted lines carry monotonic indexes ([total] never resets —
 * `clear()` on navigation empties the ring, the counters keep counting), a
 * [dropped] counter tracks ring evictions, and [since] reads any window the
 * agent asks for. An optional [sink] receives every accepted line for the
 * JSONL capture ([ConsoleLogFile]) — disk is the agent's grep channel.
 */
class BrowserConsoleBuffer(
    private val max: Int = 300,
    private val sink: ((ConsoleEntry) -> Unit)? = null,
) {

    private val lock = Any()
    private val lines = ArrayDeque<ConsoleEntry>()
    private var totalCounter = 0
    private var droppedCounter = 0

    /** Monotonic count of accepted lines (never reset by [clear]). */
    val total: Int get() = synchronized(lock) { totalCounter }

    /** Lines evicted by ring capacity (page clears don't count as drops). */
    val dropped: Int get() = synchronized(lock) { droppedCounter }

    /**
     * One DevTools event. [name] is the CDP method name ("Runtime.consoleAPICalled",
     * "Log.entryAdded", …), [payload] the raw JSON params. Unparseable input
     * is dropped silently — this channel is best-effort by design.
     */
    fun onDevToolsEvent(name: String, payload: String) {
        val line = parseLine(name, payload) ?: return
        accept(line)
    }

    /**
     * The most recent lines, oldest first, capped at [limit]. The F-206
     * ride-along on every snapshot answer.
     */
    fun recent(limit: Int = 8): List<String> = synchronized(lock) {
        lines.takeLast(limit.coerceAtMost(max)).map { it.text }
    }

    /**
     * 053 B3: lines with index > [index], up to [limit], oldest first — the
     * agent's paged readback (the tool clamps `index`/`limit` first).
     */
    fun since(index: Int, limit: Int): List<ConsoleEntry> = synchronized(lock) {
        if (limit <= 0) return@synchronized emptyList()
        lines.filter { it.index > index }.take(limit)
    }

    /** 053 B3: the counters and one window in a single lockstep read. */
    fun window(index: Int, limit: Int): ConsoleWindow = synchronized(lock) {
        ConsoleWindow(totalCounter, droppedCounter, if (limit <= 0) emptyList() else lines.filter { it.index > index }.take(limit))
    }

    /**
     * F-206 round 2: one tap event straight from the injected page shim
     * (console.error/warning routed over the JSQuery channel). Same bounded
     * buffer, no DevTools dependency.
     */
    fun onTapLine(level: String, text: String) {
        if (level != "error" && level != "warning") return
        accept(LogSafe.truncate("console.$level: $text"))
    }

    fun clear() = synchronized(lock) { lines.clear() }

    private fun accept(text: String) {
        val entry: ConsoleEntry
        val notify: ((ConsoleEntry) -> Unit)?
        synchronized(lock) {
            totalCounter += 1
            entry = ConsoleEntry(totalCounter, text)
            lines.addLast(entry)
            while (lines.size > max) {
                lines.removeFirst()
                droppedCounter += 1
            }
            notify = sink
        }
        // Sink outside the lock: file IO must never extend the buffer's
        // critical section (the CEF callback thread feeds this path).
        try {
            notify?.invoke(entry)
        } catch (_: Exception) {
            // A failing disk sink must not break console capture.
        }
    }

    companion object {

        /**
         * Pure parser for one CDP event. Returns a compact display line, or
         * null when the event is not an error/warning console output. Kept
         * static and side-effect-free so the shape contract is unit-tested.
         */
        fun parseLine(name: String, payload: String?): String? {
            if (payload.isNullOrBlank()) return null
            return try {
                val params = Json.parseToJsonElement(payload).jsonObject
                when (name) {
                    "Runtime.consoleAPICalled" -> {
                        val type = params["type"]?.jsonPrimitive?.content ?: return null
                        // Keep the useful severities; console.log noise is not
                        // what the model needs when a page misbehaves.
                        if (type !in SEVERITIES) return null
                        val text = params["args"]?.jsonArray?.joinToString(" ") { arg ->
                            val obj = arg.jsonObject
                            obj["value"]?.jsonPrimitive?.content
                                ?: obj["description"]?.jsonPrimitive?.content
                                ?: obj["type"]?.jsonPrimitive?.content
                                ?: ""
                        }?.trim().orEmpty()
                        if (text.isBlank()) return null
                        LogSafe.truncate("console.$type: $text")
                    }
                    "Log.entryAdded" -> {
                        val entry = params["entry"]?.jsonObject ?: return null
                        val level = entry["level"]?.jsonPrimitive?.content ?: return null
                        if (level !in SEVERITIES) return null
                        val text = entry["text"]?.jsonPrimitive?.content ?: return null
                        val source = entry["source"]?.jsonPrimitive?.content
                        val prefix = if (source.isNullOrBlank()) "log.$level" else "log.$level($source)"
                        LogSafe.truncate("$prefix: $text")
                    }
                    else -> null
                }
            } catch (_: Exception) {
                null
            }
        }

        private val SEVERITIES = setOf("error", "warning", "assert")
    }
}
