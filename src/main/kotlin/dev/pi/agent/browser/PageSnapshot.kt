package dev.pi.agent.browser

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The agent tool's view of the loaded page (spec 049 US4): a read-only text
 * snapshot, deliberately bounded — the model needs enough to judge "did my
 * app render", not the whole DOM dump.
 */
data class PageSnapshot(
    val ok: Boolean,
    /** Failure reason when [ok] is false (timeouts, CSP blocks, no page). */
    val reason: String?,
    /** Kernel-tracked URL — RAW since F-103 (the model, not a log file, reads this). */
    val url: String,
    val title: String,
    val readyState: String,
    val text: String,
) {
    companion object {
        fun failure(reason: String, url: String) = PageSnapshot(
            ok = false, reason = reason, url = url, title = "", readyState = "", text = "",
        )
    }
}

object PageSnapshotSanitizer {

    /** Same bound the injected script already applied — a second belt here. */
    const val MAX_TEXT_CHARS = 3000

    /**
     * Control characters never help a model; they do corrupt log-adjacent
     * surfaces and terminal rendering. Keeps \n and \t, strips the rest
     * (C0/C1), then caps the length.
     */
    fun cleanText(raw: String, maxChars: Int = MAX_TEXT_CHARS): String {
        if (raw.isEmpty()) return ""
        val sb = StringBuilder(raw.length)
        for (ch in raw) {
            if (ch == '\n' || ch == '\t') {
                sb.append(ch)
                continue
            }
            if (ch < ' ') continue // C0 control characters
            if (ch.code in 0x7F..0x9F) continue // DEL + C1 controls
            sb.append(ch)
        }
        return if (sb.length > maxChars) sb.substring(0, maxChars) else sb.toString()
    }

    /**
     * Parses the JSON the injected script produced. Any surprise (null,
     * malformed JSON, wrong shape) degrades to a failure snapshot — never an
     * exception into the CEF handler thread, never a hung read.
     */
    fun fromJs(raw: String?, url: String, kernelTitle: String): PageSnapshot {
        val text = raw ?: return PageSnapshot.failure("empty read response", url)
        return try {
            val obj = Json.parseToJsonElement(text).jsonObject
            val error = obj["error"]?.jsonPrimitive?.content
            if (!error.isNullOrBlank()) {
                PageSnapshot.failure(LogSafe.truncate(error), url)
            } else {
                PageSnapshot(
                    ok = true,
                    reason = null,
                    url = url,
                    // document.title and the display-handler title can race; the
                    // page-side value wins when present.
                    title = cleanText(obj["title"]?.jsonPrimitive?.content ?: kernelTitle, 200),
                    readyState = cleanText(obj["ready"]?.jsonPrimitive?.content ?: "", 20),
                    text = cleanText(obj["text"]?.jsonPrimitive?.content ?: ""),
                )
            }
        } catch (e: Exception) {
            PageSnapshot.failure("unreadable page response", url)
        }
    }

    /**
     * F-206/F-207 round 2: the page-side tap riding the SAME query channel as
     * the read script. Captures console.error/warning into a page buffer AND
     * ships each entry back through [injectStatement] (which references the
     * `tapEvent` variable); overrides alert/confirm/prompt so page dialogs
     * surface as IDE notifications instead of vanishing. Idempotent per
     * document; read-only otherwise (it wraps, it never fabricates calls).
     */
    fun buildTapScript(injectStatement: String): String {
        return """
            (function(){
              if (window.__piTapInstalled) return;
              window.__piTapInstalled = true;
              window.__piConsoleLines = [];
              var send = function(obj){
                try {
                  var tapEvent = JSON.stringify(obj);
                  %INJECT%
                } catch (e) {}
              };
              ['error','warn'].forEach(function(level){
                var orig = console[level] ? console[level].bind(console) : function(){};
                console[level] = function(){
                  try {
                    var text = Array.prototype.map.call(arguments, function(a){ return String(a); }).join(' ').slice(0, 300);
                    if (window.__piConsoleLines.length > 12) window.__piConsoleLines.shift();
                    window.__piConsoleLines.push(level + ': ' + text);
                    if (level === 'error') send({kind:'console', level: level, text: text});
                  } catch (e) {}
                  orig.apply(null, arguments);
                };
              });
              window.alert = function(m){ send({kind:'dialog', type:'alert', text:String(m).slice(0,300)}); };
              window.confirm = function(m){ send({kind:'dialog', type:'confirm', text:String(m).slice(0,300)}); return false; };
              window.prompt = function(m,d){ send({kind:'dialog', type:'prompt', text:String(m).slice(0,300)}); return null; };
            })()
        """.trimIndent().replace("%INJECT%", injectStatement)
    }

    /**
     * The injected read script. [injectStatement] comes from
     * `JBCefJSQuery.inject("result")` and references the `result` variable
     * this IIFE declares — the whole thing is read-only by construction
     * (title/readyState/innerText excerpt out, nothing in, nothing written).
     *
     * 053 B2: with a [selector] the script excerpts THAT element instead of
     * the whole page — [format] picks `outerHTML` (structure) or `innerText`
     * (visible text, the pre-053 default). A miss degrades to the error
     * field, which [fromJs] turns into a failure snapshot naming the
     * selector; the excerpt rides the same cleanText cap on the way back.
     */
    fun buildReadScript(
        injectStatement: String,
        maxChars: Int = MAX_TEXT_CHARS,
        selector: String? = null,
        format: String? = null,
    ): String {
        if (selector.isNullOrBlank()) {
            return """
                (function() {
                  var result;
                  try {
                    result = JSON.stringify({
                      title: String(document.title || ''),
                      ready: String(document.readyState || ''),
                      text: String((document.body && document.body.innerText) || '').slice(0, $maxChars)
                    });
                  } catch (e) {
                    result = JSON.stringify({ title: '', ready: 'error', text: '', error: String((e && e.message) || e) });
                  }
                  $injectStatement
                })()
            """.trimIndent()
        }
        val jsSelector = jsString(selector.take(MAX_SELECTOR_CHARS))
        // format is codec-validated ("html"/"text"); anything else reads text.
        val extract = if (format == "html") "el.outerHTML" else "el.innerText"
        return """
            (function() {
              var result;
              var sel = $jsSelector;
              try {
                var el = document.querySelector(sel);
                if (!el) {
                  result = JSON.stringify({ title: '', ready: 'no-match', text: '', error: 'no element matches selector: ' + sel });
                } else {
                  result = JSON.stringify({
                    title: String(document.title || ''),
                    ready: String(document.readyState || ''),
                    text: String($extract || '').slice(0, $maxChars)
                  });
                }
              } catch (e) {
                result = JSON.stringify({ title: '', ready: 'error', text: '', error: String((e && e.message) || e) });
              }
              $injectStatement
            })()
        """.trimIndent()
    }

    /** Selector cap for the script side; the codec clamps first, this is the belt. */
    const val MAX_SELECTOR_CHARS = 200

    /**
     * Embeds [raw] as a JS string literal: JSON-style escaping (quotes,
     * backslashes, control characters) is valid inside a JS string, so a
     * hostile selector stays inert string content — never code.
     *
     * 057: shared with the action scripts (click selector / type text /
     * evaluate code embed the same way) — one escaping implementation, so
     * the destroyer set (quotes, backslashes, newlines, CJK, `</script>`)
     * is locked once in PageSnapshotSanitizerTest + BrowserActionScriptsTest.
     */
    internal fun jsString(raw: String): String {
        val sb = StringBuilder(raw.length + 2)
        sb.append('"')
        for (ch in raw) {
            when {
                ch == '\\' -> sb.append("\\\\")
                ch == '"' -> sb.append("\\\"")
                ch == '\n' -> sb.append("\\n")
                ch == '\r' -> sb.append("\\r")
                ch == '\t' -> sb.append("\\t")
                ch < ' ' || ch.code in 0x7F..0x9F -> sb.append("\\u%04x".format(ch.code))
                else -> sb.append(ch)
            }
        }
        sb.append('"')
        return sb.toString()
    }
}
