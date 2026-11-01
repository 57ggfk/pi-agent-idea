package dev.pi.agent.session

import dev.pi.agent.process.OsProcess
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

/** One resumable pi session file. */
data class SessionSummary(
    val file: String,
    val id: String?,
    val timestamp: String?,
    val cwd: String?,
    val name: String?,
    val preview: String?,
    val modifiedAt: Long,
)

/**
 * Indexes pi session files (`~/.pi/agent/sessions/**/*.jsonl`).
 *
 * Project matching uses the session header's `cwd` field rather than
 * replicating pi's directory-name encoding, which keeps this resilient to
 * encoding changes across pi versions.
 */
object PiSessionIndex {

    private val json = Json { ignoreUnknownKeys = true }

    private fun sessionsRoot(): File {
        System.getenv("PI_CODING_AGENT_SESSION_DIR")?.let { return File(it) }
        return File(System.getProperty("user.home"), ".pi/agent/sessions")
    }

    /** Lists sessions for [projectPath], most recently modified first. */
    fun list(projectPath: String, limit: Int = 100, rootOverride: File? = null): List<SessionSummary> {
        val root = rootOverride ?: sessionsRoot()
        if (!root.isDirectory) return emptyList()

        val target = normalizeCwd(projectPath)
        val summaries = mutableListOf<SessionSummary>()
        root.walkTopDown()
            .filter { it.isFile && it.extension == "jsonl" }
            .forEach { file ->
                parseHeader(file)?.let { summary ->
                    summary.cwd?.let { if (normalizeCwd(it) == target) summaries.add(summary) }
                }
            }
        return summaries.sortedByDescending { it.modifiedAt }.take(limit)
    }

    /**
     * cwd comparison tolerant of Windows quirks: unify separators, drop
     * trailing separators, and ignore case on Windows. pi records the cwd it
     * was launched with; IDEA's basePath can differ in case, separator
     * direction, or a trailing slash, which previously made the session list
     * silently empty.
     */
    private fun normalizeCwd(path: String): String {
        val unified = path.replace('\\', '/').trimEnd('/')
        return if (OsProcess.isWindows) unified.lowercase() else unified
    }

    private fun parseHeader(file: File): SessionSummary? {
        var id: String? = null
        var timestamp: String? = null
        var cwd: String? = null
        var name: String? = null
        var preview: String? = null

        try {
            file.useLines { lines ->
                var scanned = 0
                for (line in lines) {
                    scanned++
                    if (scanned > 4000) break
                    val obj = runCatching { json.parseToJsonElement(line) }.getOrNull() as? JsonObject ?: continue
                    when (obj["type"]?.jsonPrimitive?.content) {
                        "session" -> {
                            id = obj["id"]?.jsonPrimitive?.content
                            timestamp = obj["timestamp"]?.jsonPrimitive?.content
                            cwd = obj["cwd"]?.jsonPrimitive?.content
                        }
                        "session_info" -> {
                            obj["name"]?.jsonPrimitive?.content?.let { name = it }
                        }
                        "message" -> {
                            if (preview == null) {
                                val message = obj["message"] as? JsonObject
                                if (message?.get("role")?.jsonPrimitive?.content == "user") {
                                    preview = firstUserText(message["content"]).takeIf { it.isNotBlank() }
                                }
                            }
                        }
                    }
                    if (id != null && name != null && preview != null) break
                }
            }
        } catch (_: Exception) {
            return null
        }

        return SessionSummary(
            file = file.absolutePath,
            id = id,
            timestamp = timestamp,
            cwd = cwd,
            name = name,
            preview = preview,
            modifiedAt = file.lastModified(),
        )
    }

    private fun firstUserText(content: kotlinx.serialization.json.JsonElement?): String {
        return when (content) {
            is kotlinx.serialization.json.JsonPrimitive -> content.content
            is kotlinx.serialization.json.JsonArray ->
                content.mapNotNull { block ->
                    (block as? JsonObject)?.takeIf { it["type"]?.jsonPrimitive?.content == "text" }
                        ?.get("text")?.jsonPrimitive?.content
                }.joinToString(" ")
            else -> ""
        }
    }
}
