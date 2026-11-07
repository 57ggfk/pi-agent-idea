package dev.pi.agent.session

import dev.pi.agent.process.OsProcess
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.io.RandomAccessFile
import java.time.Instant

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
                    // Header extraction parses until complete, bounded. A
                    // rename appends a NEW session_info entry after the
                    // header was already complete (pi's list takes the last
                    // one), so those lines must never be skipped — the
                    // marker check above keeps the fast path cheap.
                    val isInfoLine = SESSION_INFO_MARKER in line
                    if (parsed > 4000 && !isInfoLine) continue
                    if (id != null && name != null && preview != null && !isInfoLine) continue
                    parsed++
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

    /**
     * Renames an offline session by appending a `session_info` entry — the
     * same record pi itself writes on rename (sanitised, id + parentId +
     * timestamp), so pi's own list/resume and this index agree on the name.
     * The live session must go through pi's `set_session_name` RPC instead:
     * the process owns that file and keeps its name in memory.
     */
    fun renameSessionFile(path: String, name: String, rootOverride: File? = null) {
        val cleaned = name.replace(Regex("[\\r\\n]+"), " ").trim()
        check(cleaned.isNotEmpty()) { "session name must not be blank" }
        val file = sessionFileFor(path, rootOverride ?: sessionsRoot())
        val entry = buildJsonObject {
            put("type", "session_info")
            put("id", newEntryId())
            tailLeafId(file)?.let { put("parentId", it) }
            put("timestamp", Instant.now().toString())
            put("name", cleaned)
        }
        RandomAccessFile(file, "rw").use { raf ->
            if (raf.length() > 0 && !endsWithNewline(raf)) raf.write('\n'.code)
            raf.seek(raf.length())
            raf.write(entry.toString().toByteArray(Charsets.UTF_8))
            raf.write('\n'.code)
        }
    }

    /** pi-shaped short entry id: eight hex chars, as in every recorded entry. */
    private fun newEntryId(): String {
        val uuid = java.util.UUID.randomUUID().toString().replace("-", "")
        return uuid.substring(0, 8)
    }

    /** True when the file's last byte is a newline (safe to append an entry). */
    private fun endsWithNewline(raf: RandomAccessFile): Boolean {
        raf.seek(raf.length() - 1)
        return raf.read() == '\n'.code
    }

    /**
     * The `id` of the file's last entry, so the appended entry chains onto
     * pi's entry tree. Reads only the tail: a truncated last line simply
     * yields null, and pi tolerates a missing parentId (root entry).
     */
    private fun tailLeafId(file: File): String? {
        val tailLen = 8192L
        return runCatching {
            RandomAccessFile(file, "r").use { raf ->
                val start = maxOf(0L, raf.length() - tailLen)
                val buf = ByteArray((raf.length() - start).toInt())
                raf.seek(start)
                raf.readFully(buf)
                String(buf, Charsets.UTF_8)
                    .lineSequence()
                    .lastOrNull { it.isNotBlank() }
                    ?.let { line ->
                        (json.parseToJsonElement(line) as? JsonObject)
                            ?.get("id")?.jsonPrimitive?.content
                    }
            }
        }.getOrNull()
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
    private const val SESSION_INFO_MARKER = "\"type\":\"session_info\""
}
