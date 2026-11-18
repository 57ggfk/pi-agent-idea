package dev.pi.agent.browser

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** What the pi_browser tool asked the IDE to do (spec 049 D1/D2). */
enum class AgentAction {
    OPEN, READ, RELOAD;

    companion object {
        fun from(raw: String?): AgentAction? = AgentAction.entries.firstOrNull { it.name.equals(raw, ignoreCase = true) }
    }
}

/** One parsed agent-browser request; [url] is required for OPEN/RELOAD, ignored by READ. */
data class AgentBrowserRequest(val action: AgentAction, val url: String?)

object AgentBrowserRequestCodec {

    /**
     * Parses the POST body of `/agent-browser`. Anything malformed degrades to
     * an [Invalid] with a model-readable reason — the endpoint answers 200
     * with `{ok:false, reason}` so the agent sees the problem as a tool
     * result instead of a transport error.
     */
    fun parse(body: String?): AgentParseResult = when {
        body.isNullOrBlank() -> AgentParseResult.Invalid("empty request body")
        else -> try {
            val obj = Json.parseToJsonElement(body).jsonObject
            val action = AgentAction.from(obj["action"]?.jsonPrimitive?.content)
            if (action == null) {
                AgentParseResult.Invalid("unknown action; use open/read/reload")
            } else {
                val url = obj["url"]?.jsonPrimitive?.content?.trim()
                if (action != AgentAction.READ && url.isNullOrBlank()) {
                    AgentParseResult.Invalid("action ${action.name} requires a url")
                } else {
                    AgentParseResult.Valid(AgentBrowserRequest(action, url))
                }
            }
        } catch (e: Exception) {
            AgentParseResult.Invalid("request body is not valid JSON")
        }
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
