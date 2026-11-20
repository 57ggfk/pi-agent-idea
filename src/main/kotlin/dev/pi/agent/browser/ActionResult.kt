package dev.pi.agent.browser

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/**
 * 057 浏览器操作层: the outcome of one injected click/type/evaluate, shaped
 * like [PageSnapshot]/[ScrollResult] — a total object the kernel completes
 * futures with, never a thrown exception. [ok] means "the execution
 * round-trip completed": a click MISS is still ok (found=false + reason),
 * while a page-side JS throw is ok=false with the model-readable [error].
 */
data class ActionResult(
    val ok: Boolean,
    /** Failure reason when [ok] is false, or the miss explanation for click/type. */
    val reason: String?,
    /** Page-side error (JS throw) — rides the answer as the `error` field. */
    val error: String? = null,
    /** click/type: whether the selector matched. */
    val found: Boolean? = null,
    /** click: matched element's tag, lowercased. */
    val tag: String? = null,
    /** click: the matched element's first 80 characters of text. */
    val text: String? = null,
    /** type: characters written. */
    val typed: Int? = null,
    /** evaluate: the JSON-stringified completion value, cleaned and capped. */
    val value: String? = null,
) {
    companion object {

        fun failure(reason: String) = ActionResult(ok = false, reason = reason)

        fun noPage() = failure("browser tab is not open; use open first")

        fun rendererDown() = failure("browser renderer is down")

        fun stillStarting() = failure("browser is still starting")

        fun inFlight() = failure("another action is still in flight; retry shortly")

        fun timedOut() = failure("action timed out; the page may still be loading or blocked")

        fun closed() = failure("browser closed during action")

        /**
         * Parses the JSON the injected action script produced. Any surprise
         * (null, malformed, unknown action shape) degrades to a failure
         * result — never an exception into the CEF handler thread.
         */
        fun fromJs(raw: String?): ActionResult {
            val text = raw ?: return failure("empty action response")
            return try {
                val obj = Json.parseToJsonElement(text).jsonObject
                when (obj.actionName()) {
                    "click", "type" -> {
                        val explicitOk = obj.bool("ok")
                        if (explicitOk == false) {
                            val error = obj.string("error") ?: "unknown error"
                            ActionResult(
                                ok = false,
                                reason = "${obj.actionName()} failed: ${LogSafe.truncate(error)}",
                                error = LogSafe.truncate(error),
                            )
                        } else {
                            val found = obj.bool("found") ?: return failure("unreadable action response")
                            if (found) {
                                ActionResult(
                                    ok = true,
                                    reason = null,
                                    found = true,
                                    tag = obj.string("tag")?.takeIf { it.isNotBlank() },
                                    text = obj.string("text")?.let { PageSnapshotSanitizer.cleanText(it, BrowserActionScripts.MAX_ELEMENT_TEXT_CHARS) },
                                    typed = if (obj.actionName() == "type") obj.int("typed") else null,
                                )
                            } else {
                                ActionResult(ok = true, reason = obj.string("error") ?: "element not found", found = false)
                            }
                        }
                    }
                    "evaluate" -> {
                        if (obj.bool("ok") == false) {
                            val error = obj.string("error") ?: "unknown error"
                            ActionResult(
                                ok = false,
                                reason = "evaluate failed: ${LogSafe.truncate(error)}",
                                error = LogSafe.truncate(error),
                            )
                        } else {
                            ActionResult(
                                ok = true,
                                reason = null,
                                value = obj.string("value")?.let { PageSnapshotSanitizer.cleanText(it) },
                            )
                        }
                    }
                    else -> failure("unreadable action response")
                }
            } catch (e: Exception) {
                failure("unreadable action response")
            }
        }

        /** The action the wire payload came from, or null when absent. */
        private fun JsonObject.actionName(): String? = string("action")

        /** String content of a primitive member; JSON null and absent read the same. */
        private fun JsonObject.string(key: String): String? {
            val el = this[key] ?: return null
            if (el is JsonNull) return null
            if (el !is JsonPrimitive) return null
            return el.content
        }

        private fun JsonObject.bool(key: String): Boolean? = when (val el = this[key]) {
            is JsonPrimitive -> el.content.toBooleanStrictOrNull()
            else -> null
        }

        private fun JsonObject.int(key: String): Int? = string(key)?.toIntOrNull()
    }
}
