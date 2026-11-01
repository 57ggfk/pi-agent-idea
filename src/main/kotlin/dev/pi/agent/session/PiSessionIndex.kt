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
    val messageCount: Int = 0,
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
        var messageCount = 0

        try {
            file.useLines { lines ->
                var parsed = 0
                for (line in lines) {
                    // Raw marker count runs over the whole file (cheap, no
                    // JSON parsing) so the UI can show a message total even
                    // for large sessions.
                    if (MESSAGE_MARKER in line) messageCount++
                    // Header extraction parses until complete, bounded.
                    if (id != null && name != null && preview != null) continue
                    parsed++
                    if (parsed > 4000) continue
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
            messageCount = messageCount,
        )
    }

    /**
     * Resolves a session path sent back by the UI: it must live under the
     * sessions root and exist. The UI only echoes paths from [list], but
     * these methods touch the filesystem so the path is never trusted
     * blindly.
     */
    fun sessionFileFor(path: String, rootOverride: File? = null): File {
        val candidate = File(path)
        check(isInsideRoot(candidate, rootOverride ?: sessionsRoot())) {
            "refusing to touch a path outside the sessions root: $path"
        }
        check(candidate.isFile) { "not a session file: $path" }
        return candidate
    }

    /** Deletes a session file after verifying it lives under the sessions root. */
    fun deleteSessionFile(path: String, rootOverride: File? = null) {
        sessionFileFor(path, rootOverride).delete()
    }

    /** True when [candidate] is [root] itself or a descendant of it. */
    internal fun isInsideRoot(candidate: File, root: File): Boolean {
        val rootPath = runCatching { root.canonicalFile.path }.getOrNull() ?: return false
        val candidatePath = runCatching { candidate.canonicalFile.path }.getOrNull() ?: return false
        return candidatePath == rootPath || candidatePath.startsWith(rootPath + File.separator)
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

    private const val MESSAGE_MARKER = "\"type\":\"message\""
}
