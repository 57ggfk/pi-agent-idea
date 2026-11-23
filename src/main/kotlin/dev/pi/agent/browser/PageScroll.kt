package dev.pi.agent.browser

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The viewport state a scroll action reports back (spec 053 B2). The kernel
 * routes the response over the SAME read-only JSQuery channel as the page
 * snapshot — the D4 revision ("read-only DOM + viewport scrolling") lets
 * `window.scrollBy` be the one mutation this channel performs.
 */
data class ScrollResult(
    val ok: Boolean,
    /** Failure reason when [ok] is false (no page, timeout, CSP, no match). */
    val reason: String?,
    val scrollY: Int,
    val scrollHeight: Int,
    val innerHeight: Int,
) {
    companion object {

        fun failure(reason: String) = ScrollResult(ok = false, reason = reason, scrollY = 0, scrollHeight = 0, innerHeight = 0)

        fun noPage() = failure("browser tab is not open; use open first")

        fun rendererDown() = failure("browser renderer is down")

        fun stillStarting() = failure("browser is still starting")

        fun inFlight() = failure("another scroll is still in flight; retry shortly")

        fun timedOut() = failure("scroll timed out; the page may still be loading or blocked")

        fun closed() = failure("browser closed during scroll")

        /**
         * Parses the JSON the injected scroll script produced. Any surprise
         * (null, malformed, wrong shape) degrades to a failure result — never
         * an exception into the CEF handler thread, never a hung scroll.
         */
        fun fromJs(raw: String?): ScrollResult {
            val text = raw ?: return failure("empty scroll response")
            return try {
                val obj = Json.parseToJsonElement(text).jsonObject
                val error = obj["error"]?.jsonPrimitive?.content
                if (!error.isNullOrBlank()) {
                    ScrollResult.failure(LogSafe.truncate(error))
                } else {
                    // A missing scrollY means this was never a scroll response
                    // (e.g. a page snapshot raced the channel) — degrade, never
                    // report a fabricated position.
                    val scrollY = obj["scrollY"]?.jsonPrimitive?.content?.toIntOrNull()
                        ?: return ScrollResult.failure("unreadable scroll response")
                    ScrollResult(
                        ok = true,
                        reason = null,
                        scrollY = scrollY,
                        scrollHeight = obj["scrollHeight"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                        innerHeight = obj["innerHeight"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                    )
                }
            } catch (e: Exception) {
                ScrollResult.failure("unreadable scroll response")
            }
        }
    }
}

/**
 * Pure builders for the scroll half of spec 053 B2. The script moves the
 * viewport with `window.scrollBy` — nothing else — and reports the new
 * position back through the inject statement the kernel passes in.
 */
object PageScroll {

    /** Shared bound for one scroll distance (the codec clamps `amount` here too). */
    const val MAX_SCROLL_PX = 10_000

    /**
     * The injected scroll script. [direction] is "down"/"up" (anything else
     * reads as down); [amountPx] clamps into 1..[MAX_SCROLL_PX] — both
     * defenses sit BELOW the codec, which validates first.
     */
    fun buildScrollScript(injectStatement: String, direction: String, amountPx: Int): String {
        val px = amountPx.coerceIn(1, MAX_SCROLL_PX)
        val delta = if (direction.equals("up", ignoreCase = true)) -px else px
        return """
            (function() {
              var result;
              try {
                window.scrollBy(0, $delta);
                result = JSON.stringify({
                  kind: 'scroll',
                  scrollY: Math.round(window.scrollY),
                  scrollHeight: Math.round((document.documentElement && document.documentElement.scrollHeight) || 0),
                  innerHeight: Math.round(window.innerHeight || 0)
                });
              } catch (e) {
                result = JSON.stringify({ kind: 'scroll', error: String((e && e.message) || e) });
              }
              $injectStatement
            })()
        """.trimIndent()
    }
}
