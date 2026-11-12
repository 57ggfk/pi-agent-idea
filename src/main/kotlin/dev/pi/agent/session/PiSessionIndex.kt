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
 *
 * spec 021 (US4/D5): reading used to parse up to 4000 JSON lines of *every*
 * file under *every* project just to filter by cwd. Two phases now:
 *
 * 1. read the first line (pi always writes the `session` header there) — a
 *    cwd mismatch stops right here;
 * 2. only a matching file is scanned further for name / preview / count.
 *
 * Both phases are memoised per file on `(lastModified, length)`, with `null`
 * cached too so a corrupt file is not re-parsed on every list call.
 */
object PiSessionIndex {

    private val json = Json { ignoreUnknownKeys = true }

    /** Header facts, phase 1. */
    private data class Header(val id: String?, val timestamp: String?, val cwd: String?, val parentSession: String? = null)

    /** Cache key: everything that can change a file's parsed result. */
    private data class Stamp(val lastModified: Long, val length: Long)

    private val headerCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Stamp, Header?>>()
    private val summaryCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Stamp, SessionSummary?>>()

    /** Test-only instrumentation: how often each phase actually read a file. */
    internal val headerReads = java.util.concurrent.atomic.AtomicInteger()
    internal val bodyReads = java.util.concurrent.atomic.AtomicInteger()

    internal fun resetReadCounters() {
        headerReads.set(0)
        bodyReads.set(0)
    }

    private fun stampOf(file: File): Stamp = Stamp(file.lastModified(), file.length())

    internal fun sessionsRoot(): File {
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
                val header = header(file) ?: return@forEach
                // Phase 1 already answered "not this project" — the body of
                // another project's transcript is never touched.
                if (header.cwd == null || normalizeCwd(header.cwd) != target) return@forEach
                val summary = summary(file, header) ?: return@forEach
                summaries.add(summary)
            }
        return summaries.sortedByDescending { it.modifiedAt }.take(limit)
    }

    /** Phase 1: the `session` header line, cached on the file's stamp. */
    private fun header(file: File): Header? {
        val key = file.absolutePath
        val stamp = stampOf(file)
        headerCache[key]?.let { (cached, value) -> if (cached == stamp) return value }

        headerReads.incrementAndGet()
        val parsed = runCatching {
            file.bufferedReader().use { reader ->
                val first = reader.readLine() ?: return@use null
                val obj = json.parseToJsonElement(first) as? JsonObject ?: return@use null
                if (obj["type"]?.jsonPrimitive?.content != "session") return@use null
                Header(
                    id = obj["id"]?.jsonPrimitive?.content,
                    timestamp = obj["timestamp"]?.jsonPrimitive?.content,
                    cwd = obj["cwd"]?.jsonPrimitive?.content,
                    // 024: `pi --fork` writes the source file path here — the
                    // marker findNewFork() matches on.
                    parentSession = obj["parentSession"]?.jsonPrimitive?.content,
                )
            }
        }.getOrNull()

        headerCache[key] = stamp to parsed
        return parsed
    }

    /** Phase 2: name / preview / message count for a cwd-matching file. */
    private fun summary(file: File, header: Header): SessionSummary? {
        val key = file.absolutePath
        val stamp = stampOf(file)
        summaryCache[key]?.let { (cached, value) -> if (cached == stamp) return value }

        bodyReads.incrementAndGet()
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
                    if (name != null && preview != null && !isInfoLine) continue
                    parsed++
                    val obj = runCatching { json.parseToJsonElement(line) }.getOrNull() as? JsonObject ?: continue
                    when (obj["type"]?.jsonPrimitive?.content) {
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
            summaryCache[key] = stamp to null
            return null
        }

        val summary = SessionSummary(
            file = file.absolutePath,
            id = header.id,
            timestamp = header.timestamp,
            cwd = header.cwd,
            name = name,
            preview = preview,
            modifiedAt = file.lastModified(),
            messageCount = messageCount,
        )
        summaryCache[key] = stamp to summary
        return summary
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

    /**
     * 024: canonical paths of every session file currently under [root] — the
     * "before" snapshot `findNewFork` diffs against.
     */
    fun snapshotSessionFiles(rootOverride: File? = null): Set<String> {
        val root = rootOverride ?: sessionsRoot()
        if (!root.isDirectory) return emptySet()
        return root.walkTopDown()
            .filter { it.isFile && it.extension == "jsonl" }
            .mapTo(HashSet()) { it.canonicalFile.path }
    }

    /**
     * 024: the session file `pi --fork <sourceFile>` just created — a jsonl
     * under [root] that was not in [before] and whose header names the source
     * as its `parentSession`. pi writes the parent path canonicalised
     * (probe A/B), so both sides go through canonicalFile before comparing.
     * Returns the newest match, or null when nothing qualifies.
     */
    fun findNewFork(sourceFile: String, before: Set<String>, rootOverride: File? = null): File? {
        val root = rootOverride ?: sessionsRoot()
        if (!root.isDirectory) return null
        val source = runCatching { File(sourceFile).canonicalFile.path }.getOrNull() ?: return null
        var latest: File? = null
        root.walkTopDown()
            .filter { it.isFile && it.extension == "jsonl" && it.canonicalFile.path !in before }
            .forEach { file ->
                val header = header(file) ?: return@forEach
                val parent = header.parentSession ?: return@forEach
                val parentPath = runCatching { File(parent).canonicalFile.path }.getOrNull()
                if (parentPath == source) {
                    if (latest == null || file.lastModified() > latest!!.lastModified()) latest = file
                }
            }
        return latest
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
