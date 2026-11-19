package dev.pi.agent.browser

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Bounded buffer of the browser tab's page console output (F-206, 049 P2
 * "console/network 进上下文" made minimal). Events arrive over the DevTools
 * channel that the kernel attaches in reflection (the CefDevToolsClient class
 * does not exist on the 233 floor, so nothing here names it directly).
 *
 * Only error/warning-level lines are kept — the model needs "what went wrong",
 * not a debug firehose. Every line passes [LogSafe.truncate]; nothing from
 * here ever reaches idea.log (048 hard rule 8).
 */
class BrowserConsoleBuffer(private val max: Int = 50) {

    private val lock = Any()
    private val lines = ArrayDeque<String>()

    /**
     * One DevTools event. [name] is the CDP method name ("Runtime.consoleAPICalled",
     * "Log.entryAdded", …), [payload] the raw JSON params. Unparseable input
     * is dropped silently — this channel is best-effort by design.
     */
    fun onDevToolsEvent(name: String, payload: String) {
        val line = parseLine(name, payload) ?: return
        synchronized(lock) {
            lines.addLast(line)
            while (lines.size > max) lines.removeFirst()
        }
    }

    /** The most recent lines, oldest first, capped at [limit]. */
    fun recent(limit: Int = 8): List<String> = synchronized(lock) {
        lines.takeLast(limit.coerceAtMost(max))
    }

    fun clear() = synchronized(lock) { lines.clear() }

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
