package dev.pi.agent.session

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

/**
 * Renders a pi session file (.jsonl) as a minimal standalone HTML document:
 * roles and text only, no scripts, inline CSS — safe to archive or share.
 * Tool calls and images are skipped; a partially readable file still exports
 * what parsed.
 */
object SessionHtmlExporter {

    private val json = Json { ignoreUnknownKeys = true }

    data class Rendered(val html: String, val suggestedFileName: String)

    fun render(file: File): Rendered {
        var id: String? = null
        var name: String? = null
        val messages = mutableListOf<Pair<String, String>>()

        try {
            file.useLines { lines ->
                for (line in lines) {
                    val obj = runCatching { json.parseToJsonElement(line) }.getOrNull() as? JsonObject ?: continue
                    when (obj["type"]?.jsonPrimitive?.content) {
                        "session" -> id = obj["id"]?.jsonPrimitive?.content
                        "session_info" -> name = obj["name"]?.jsonPrimitive?.content
                        "message" -> {
                            val message = obj["message"] as? JsonObject ?: continue
                            val role = message["role"]?.jsonPrimitive?.content ?: continue
                            val text = textOf(message["content"])
                            if (text.isNotBlank()) messages.add(role to text)
                        }
                    }
                }
            }
        } catch (_: Exception) {
            // Keep whatever parsed; a partial export beats none.
        }

        val title = (name ?: id ?: file.nameWithoutExtension).ifBlank { file.nameWithoutExtension }
        val body = messages.joinToString("\n") { (role, text) ->
            """<div class="msg r-${escape(role)}"><span class="role">${escape(role)}</span><pre>${escape(text)}</pre></div>"""
        }
        val html = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
h1 { font-size: 1.2rem; }
.msg { border: 1px solid #e1e4e8; border-radius: 8px; margin: 0.8rem 0; padding: 0.6rem 1rem; }
.msg .role { font-weight: 600; text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.05em; color: #57606a; }
.msg pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; margin: 0.4rem 0 0; font-size: 0.92rem; }
.r-user { background: #f6f8fa; }
</style>
</head>
<body>
<h1>${escape(title)}</h1>
$body
</body>
</html>
"""
        return Rendered(html, sanitizeFileName("$title.html"))
    }

    /** All text content of a message: primitives and text blocks joined. */
    private fun textOf(content: kotlinx.serialization.json.JsonElement?): String = when (content) {
        is JsonPrimitive -> content.content
        is JsonArray -> content.mapNotNull { block ->
            (block as? JsonObject)?.takeIf { it["type"]?.jsonPrimitive?.content == "text" }
                ?.get("text")?.jsonPrimitive?.content
        }.joinToString("\n\n")
        else -> ""
    }

    private fun escape(s: String): String = s
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")

    private fun sanitizeFileName(name: String): String =
        name.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(80).ifBlank { "session.html" }
}
