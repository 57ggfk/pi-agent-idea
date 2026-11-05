package dev.pi.agent.session

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

/** One displayed snippet: role, surrounding text, ordinal within the session. */
data class SessionSearchHit(val role: String, val snippet: String, val hitIndex: Int)

/** One matching session with its aggregate hit information. */
data class SessionSearchResult(
    val file: String,
    val id: String?,
    val name: String?,
    val modifiedAt: Long,
    val hitCount: Int,
    val hits: List<SessionSearchHit>,
)

data class SessionSearchOutcome(
    val results: List<SessionSearchResult>,
    /** Sessions actually scanned (for the "已扫描 N 个会话" note). */
    val scanned: Int,
    /** A limit stopped the scan early — the UI must say so (FR-013). */
    val truncated: Boolean,
)

data class SearchLimits(
    val maxSessions: Int = 50,
    val maxHitsPerSession: Int = 2,
    val maxFileBytes: Long = 20L * 1024 * 1024,
    val timeoutMs: Long = 2_000,
    val snippetContext: Int = 60,
)

private val json = Json { ignoreUnknownKeys = true }

/**
 * Literal, case-insensitive full-text scan of the project's session files
 * (spec 006 US3). Sessions come from [PiSessionIndex] (same cwd matching as
 * the Sessions page); message text blocks are searched, thinking blocks and
 * image data never are. Broken lines are skipped, never fatal (FR-014).
 *
 * One more session than the cap is listed so an early stop can be reported
 * honestly instead of silently looking complete.
 */
fun searchSessions(
    projectPath: String,
    query: String,
    rootOverride: File? = null,
    limits: SearchLimits = SearchLimits(),
): SessionSearchOutcome {
    val needle = query.trim()
    if (needle.isEmpty()) return SessionSearchOutcome(emptyList(), 0, false)

    // limit+1: the extra entry only proves there was more to scan.
    val sessions = PiSessionIndex.list(projectPath, limit = limits.maxSessions + 1, rootOverride = rootOverride)
    val deadline = System.currentTimeMillis() + limits.timeoutMs
    val results = mutableListOf<SessionSearchResult>()
    var scanned = 0
    var truncated = sessions.size > limits.maxSessions

    for (session in sessions.take(limits.maxSessions)) {
        if (System.currentTimeMillis() > deadline) {
            truncated = true
            break
        }
        scanned++
        val file = File(session.file)
        if (!file.isFile) continue
        if (file.length() > limits.maxFileBytes) {
            truncated = true
            continue
        }
        val result = searchOneSession(session, file, needle, limits) ?: continue
        results.add(result)
    }
    return SessionSearchOutcome(results, scanned, truncated)
}

/** Scans one session file; null when nothing matched. */
private fun searchOneSession(
    session: SessionSummary,
    file: File,
    needle: String,
    limits: SearchLimits,
): SessionSearchResult? {
    var hitCount = 0
    val hits = mutableListOf<SessionSearchHit>()
    try {
        file.useLines { lines ->
            for (line in lines) {
                val (role, text) = messageTextOf(line) ?: continue
                var from = 0
                while (from <= text.length) {
                    val at = text.indexOf(needle, from, ignoreCase = true)
                    if (at < 0) break
                    if (hits.size < limits.maxHitsPerSession) {
                        hits.add(SessionSearchHit(role, snippetOf(text, at, needle.length, limits), hitCount))
                    }
                    hitCount++
                    from = at + needle.length
                }
            }
        }
    } catch (_: Exception) {
        // A torn or unreadable file yields whatever was collected so far.
    }
    if (hitCount == 0) return null
    return SessionSearchResult(session.file, session.id, session.name, session.modifiedAt, hitCount, hits)
}

/** Role + searchable text of one JSONL line; null for non-message / broken lines. */
private fun messageTextOf(line: String): Pair<String, String>? {
    val obj = try {
        json.parseToJsonElement(line).let { it as? JsonObject } ?: return null
    } catch (_: Exception) {
        return null // half-written trailing line (FR-014)
    }
    if (obj["type"]?.jsonPrimitive?.contentOrNull != "message") return null
    val message = obj["message"] as? JsonObject ?: return null
    val role = message["role"]?.jsonPrimitive?.contentOrNull ?: return null
    val content = message["content"] ?: return null
    val sb = StringBuilder()
    val ok = runCatching {
        if (content is kotlinx.serialization.json.JsonPrimitive) {
            sb.append(content.content)
        } else {
            for (block in content.jsonArray) {
                val rec = block as? JsonObject ?: continue
                if (rec["type"]?.jsonPrimitive?.contentOrNull == "text") {
                    sb.append(rec["text"]?.jsonPrimitive?.contentOrNull ?: "").append('\n')
                }
                // thinking / image blocks are deliberately not searched.
            }
        }
    }.isSuccess
    if (!ok) return null
    val text = sb.toString()
    return if (text.isEmpty()) null else role to text
}

private fun snippetOf(text: String, at: Int, length: Int, limits: SearchLimits): String {
    val start = maxOf(0, at - limits.snippetContext)
    val end = minOf(text.length, at + length + limits.snippetContext)
    val body = text.substring(start, end).replace(Regex("\\s+"), " ").trim()
    return (if (start > 0) "…" else "") + body + (if (end < text.length) "…" else "")
}
