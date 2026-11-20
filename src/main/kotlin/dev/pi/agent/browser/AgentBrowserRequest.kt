package dev.pi.agent.browser

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.roundToInt

/** What the pi_browser tool asked the IDE to do (spec 049 D1/D2, 053 B1, 056 list). */
enum class AgentAction {
    OPEN, READ, RELOAD, SCROLL, CONSOLE, LIST;

    companion object {
        fun from(raw: String?): AgentAction? = AgentAction.entries.firstOrNull { it.name.equals(raw, ignoreCase = true) }
    }
}

/** Where `scroll` moves the viewport; null means the tool's "down" default. */
val SCROLL_DIRECTIONS = setOf("down", "up")

/** What `read` excerpts from a matched element: markup or visible text. */
val READ_FORMATS = setOf("html", "text")

/**
 * 054: which carrier the agent's browser action targets — the tool-window
 * tab (`tab`, the 048 default) or the editor-form preview (`editor`, 054
 * 变更 1: the link right-click menu's "Open in Pi editor"). Absent means
 * "wherever the last `open` landed" ([PiBrowserManager.lastAgentCarrier]).
 */
val BROWSER_TARGETS = setOf("tab", "editor")

/**
 * One parsed agent-browser request. [url] is required for RELOAD, ignored by
 * READ, and OPTIONAL for OPEN since F-214: an absent url means "auto-detect
 * the dev server port" ([DevServerProbe]) — the Cursor-2.0-style awareness
 * that saves the agent one shell round-trip per verification.
 *
 * 053 adds the observation-side parameters: [scrollDirection]/[scrollAmount]
 * for SCROLL, [selector]/[format] for READ's element excerpt, and
 * [consoleLimit]/[consoleSince] for CONSOLE readback. All default to null —
 * a body without them parses byte-for-byte like the pre-053 contract.
 */
data class AgentBrowserRequest(
    val action: AgentAction,
    val url: String?,
    val scrollDirection: String? = null,
    val scrollAmount: Int? = null,
    val selector: String? = null,
    val format: String? = null,
    val consoleLimit: Int? = null,
    val consoleSince: Int? = null,
    /** 054: "tab" = tool-window tab, "editor" = editor-form preview; null = the last-opened carrier. */
    val target: String? = null,
    /**
     * 056: the exact panel to operate on — a [BrowserTabIds] id (`t1`, `e2`)
     * from open/list results. Absent = follow the tab the last open landed
     * on ([PiBrowserManager.lastTabId]), then the 055 carrier fallback. When
     * both [tab] and [target] are present the TOOL layer gives [tab]
     * precedence (the codec accepts both — see AgentBrowserTool).
     */
    val tab: String? = null,
)

object AgentBrowserRequestCodec {

    /** `amount` clamps into 1..10000 device-independent px (053 B1). */
    const val MAX_SCROLL_AMOUNT = 10_000

    /** `limit` clamps into 1..200 preview lines (053 B3). */
    const val MAX_CONSOLE_LIMIT = 200

    /** A selector is a lookup key, not a payload — keep it a bounded one. */
    const val MAX_SELECTOR_CHARS = 200

    private val KNOWN_PARAMS = setOf("action", "url", "direction", "amount", "selector", "format", "limit", "since", "target", "tab")

    private val KNOWN_PARAMS_HINT = "use action/url/target/tab/direction/amount/selector/format/limit/since"

    /**
     * Parses the POST body of `/agent-browser`. Anything malformed degrades to
     * an [Invalid] with a model-readable reason — the endpoint answers 200
     * with `{ok:false, reason}` so the agent sees the problem as a tool
     * result instead of a transport error. Unknown parameter NAMES and
     * malformed VALUES are reported, not silently ignored: the model can fix
     * its call on the next round instead of wondering why nothing changed.
     */
    fun parse(body: String?): AgentParseResult = when {
        body.isNullOrBlank() -> AgentParseResult.Invalid("empty request body")
        else -> try {
            val obj = Json.parseToJsonElement(body).jsonObject
            val action = AgentAction.from(text(obj, "action"))
            if (action == null) {
                AgentParseResult.Invalid("unknown action; use open/read/reload/scroll/console/list")
            } else {
                val unknown = obj.keys.firstOrNull { it !in KNOWN_PARAMS }
                if (unknown != null) {
                    AgentParseResult.Invalid("unknown parameter \"$unknown\"; $KNOWN_PARAMS_HINT")
                } else {
                    val url = text(obj, "url")?.trim()
                    // F-214: OPEN without a url is the auto-detect contract; RELOAD
                    // has nothing to auto-detect (it replays the loaded page).
                    if (action == AgentAction.RELOAD && url.isNullOrBlank()) {
                        AgentParseResult.Invalid("action ${action.name} requires a url")
                    } else {
                        parseParams(action, obj, url)
                    }
                }
            }
        } catch (e: Exception) {
            AgentParseResult.Invalid("request body is not valid JSON")
        }
    }

    /** 053: the observation-side parameters, shared by every action's body. */
    private fun parseParams(action: AgentAction, obj: JsonObject, url: String?): AgentParseResult {
        val direction = text(obj, "direction")?.trim()?.lowercase()
        if (direction != null && direction !in SCROLL_DIRECTIONS) {
            return AgentParseResult.Invalid("direction must be \"down\" or \"up\"")
        }
        val amount = number(obj, "amount")
            ?: if (obj.containsKey("amount")) {
                return AgentParseResult.Invalid("amount must be a number between 1 and $MAX_SCROLL_AMOUNT")
            } else null
        val selector = text(obj, "selector")?.trim()?.take(MAX_SELECTOR_CHARS)
        val format = text(obj, "format")?.trim()?.lowercase()
        if (format != null && format !in READ_FORMATS) {
            return AgentParseResult.Invalid("format must be \"html\" or \"text\"")
        }
        val limit = number(obj, "limit")
            ?: if (obj.containsKey("limit")) {
                return AgentParseResult.Invalid("limit must be a number between 1 and $MAX_CONSOLE_LIMIT")
            } else null
        val since = number(obj, "since")
            ?: if (obj.containsKey("since")) {
                return AgentParseResult.Invalid("since must be a non-negative line index")
            } else null
        val target = text(obj, "target")?.trim()?.lowercase()
        if (target != null && target !in BROWSER_TARGETS) {
            return AgentParseResult.Invalid("target must be \"tab\" or \"editor\"")
        }
        // 056: tab ids are FORMAT-checked here (t1/e2 …); an id that looks
        // right but names no live panel is a RUNTIME miss — the tool answers
        // "no browser tab t9", the codec stays transport-shaped.
        val tab = text(obj, "tab")?.trim()
        if (tab != null && !BrowserTabIds.isValid(tab)) {
            return AgentParseResult.Invalid(
                "tab must be a tab id like t1 or e2 (as returned by open/list results), got \"$tab\"",
            )
        }
        return AgentParseResult.Valid(
            AgentBrowserRequest(
                action = action,
                url = url,
                scrollDirection = direction,
                scrollAmount = amount?.roundToInt()?.coerceIn(1, MAX_SCROLL_AMOUNT),
                selector = selector,
                format = format,
                consoleLimit = limit?.roundToInt()?.coerceIn(1, MAX_CONSOLE_LIMIT),
                consoleSince = since?.roundToInt()?.coerceAtLeast(0),
                target = target,
                tab = tab,
            ),
        )
    }

    /** String content of a primitive param; JSON null reads as absent. Non-primitives throw (degrade in [parse]). */
    private fun text(obj: JsonObject, key: String): String? {
        val el = obj[key] ?: return null
        if (el is JsonNull) return null
        return el.jsonPrimitive.content
    }

    /**
     * Numeric param as a double: accepts JSON numbers and numeric strings
     * ("800"), clamps later. Returns null both when absent and when present
     * but non-numeric — [parseParams] distinguishes via [JsonObject.containsKey].
     */
    private fun number(obj: JsonObject, key: String): Double? {
        val el = obj[key] ?: return null
        if (el is JsonNull) return null
        return el.jsonPrimitive.content.trim().toDoubleOrNull()
    }

    /**
     * Hard rule 1 (048) continuation: the browser tab never loads a URL
     * carrying the IDE's bridge token. Returns the refusal reason, or null
     * when the URL is clean (or there is no token to check against — the
     * chat panel was never opened).
     */
    fun bridgeTokenViolation(url: String?, token: String?): String? {
        if (url == null || token.isNullOrBlank()) return null
        if (url.contains(token)) return "url contains the IDE bridge token and is refused for the browser tab"
        return null
    }
}

sealed class AgentParseResult {
    data class Valid(val request: AgentBrowserRequest) : AgentParseResult()
    data class Invalid(val reason: String) : AgentParseResult()
}
