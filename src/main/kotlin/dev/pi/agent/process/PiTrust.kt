package dev.pi.agent.process

import dev.pi.agent.manage.PiCliRunner
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Locale

/**
 * pi's project trust store (`~/.pi/agent/trust.json`).
 *
 * The file is a flat `{ "<canonical absolute path>": true }` map written by
 * pi itself. Everything that depends on project-local files (skills, MCP
 * servers, settings, extensions) is silently ignored for projects that are
 * not in this map, which is why the panel must show the state instead of
 * guessing it.
 *
 * Writing is fail-safe by contract: the file is shared with the CLI, so a
 * malformed write would break pi in the terminal too. Hence
 * backup -> mutate only the target key -> re-parse -> atomic move, and a
 * refusal to touch a file that does not parse.
 */
object PiTrust {

    /** Pretty-printed so a human can still read the store after an edit. */
    private val outJson = Json { prettyPrint = true; prettyPrintIndent = "  " }

    /** Strict: only used to validate what we are about to write. */
    private val inJson = Json

    private const val BACKUP_SUFFIX = ".bak"
    private const val TEMP_SUFFIX = ".tmp"

    /** Project-local resource categories pi gates on trust. */
    private val RESOURCE_PROBES = listOf(
        Triple("skills", "Skill definitions", listOf(".pi/skills", ".agents/skills")),
        Triple("mcp", "MCP servers", listOf(".pi/mcp.json")),
        Triple("settings", "Project settings", listOf(".pi/settings.json")),
        Triple("extensions", "Extensions", listOf(".pi/extensions")),
    )

    fun trustFile(): File = trustFile(PiCliRunner.agentDir())

    /**
     * Store file inside [storeDir]. Tests point this at a temp directory;
     * production always passes the agent dir.
     */
    fun trustFile(storeDir: File): File = File(storeDir, "trust.json")

    /**
     * Comparison form of a path: canonical (symlinks and `..` resolved),
     * forward slashes, and lowercased only on Windows where NTFS is
     * case-insensitive. Lowercasing on Linux/macOS would conflate two
     * genuinely different projects.
     */
    fun normalize(path: String): String {
        val canonical = runCatching { File(path).canonicalPath }.getOrElse { File(path).absolutePath }
        // Strip a trailing separator so "D:/a/b/" and "D:/a/b" compare equal.
        val trimmed = canonical.trimEnd('/', '\\').ifEmpty { canonical }
        val unified = trimmed.replace('\\', '/')
        return if (OsProcess.isWindows) unified.lowercase(Locale.ROOT) else unified
    }

    /** State of the store as seen from one project. */
    data class Snapshot(
        /** Absolute path of trust.json (may not exist). */
        val file: String,
        val projectPath: String,
        val trusted: Boolean,
        /** Every project path currently in the store, as written by pi. */
        val projects: List<String>,
        /** False on a normal first run: no store yet, nothing to fix. */
        val exists: Boolean = true,
        /**
         * Non-null when the file exists but cannot be parsed. Callers must
         * treat this as "untrusted" and surface the message; we never
         * silently rewrite a file we failed to understand.
         */
        val error: String? = null,
    )

    data class Resource(
        val type: String,
        val label: String,
        val scope: String = "project",
        val path: String,
        /** False when the project is untrusted: the files exist but pi ignores them. */
        val active: Boolean,
        val reason: String? = null,
    )

    data class WriteResult(
        val ok: Boolean,
        val error: String? = null,
        val snapshot: Snapshot? = null,
    )

    // -- read ---------------------------------------------------------------

    fun snapshot(projectPath: String?, storeDir: File = PiCliRunner.agentDir()): Snapshot {
        val file = trustFile(storeDir)
        val base = Snapshot(
            file = file.absolutePath,
            projectPath = projectPath ?: "",
            trusted = false,
            projects = emptyList(),
            exists = file.isFile,
        )
        if (projectPath.isNullOrBlank()) return base
        val text = readTextOrNull(file) ?: return base
        val obj = try {
            parseObject(text)
        } catch (e: Exception) {
            return base.copy(error = "cannot parse ${file.name}: ${e.message}")
        }
        val projects = obj.keys.toList()
        val target = normalize(projectPath)
        // A key written as `true` means trusted; any other value form is still
        // treated as trusted because pi only checks presence.
        val trusted = projects.any { normalize(it) == target }
        return base.copy(trusted = trusted, projects = projects)
    }

    fun isTrusted(projectPath: String?, storeDir: File = PiCliRunner.agentDir()): Boolean =
        snapshot(projectPath, storeDir).trusted

    /**
     * Project-local resources that exist on disk, tagged with whether pi will
     * actually load them. Categories with no files are omitted: an empty
     * group in the UI is noise, not information.
     */
    fun resources(projectPath: String?, trusted: Boolean): List<Resource> {
        if (projectPath.isNullOrBlank()) return emptyList()
        val root = File(projectPath)
        val out = mutableListOf<Resource>()
        for ((type, label, probes) in RESOURCE_PROBES) {
            val hit = probes.map { File(root, it) }.firstOrNull { it.exists() } ?: continue
            out += Resource(
                type = type,
                label = label,
                path = hit.absolutePath,
                active = trusted,
                reason = if (trusted) null else "project is not trusted",
            )
        }
        return out
    }

    // -- write --------------------------------------------------------------

    fun grant(projectPath: String, storeDir: File = PiCliRunner.agentDir()): WriteResult {
        if (projectPath.isBlank()) return WriteResult(false, "project path is empty")
        val file = trustFile(storeDir)
        val current = try {
            readObjectOrNull(file)
        } catch (e: Exception) {
            return WriteResult(false, refuseMessage(file, e), snapshot(projectPath, storeDir))
        }
        val key = storedKey(projectPath)
        val target = normalize(projectPath)
        val updated = buildJsonObject {
            // Drop any case/separator variant of the same project so the store
            // keeps exactly one entry per project.
            current?.forEach { (k, v) ->
                if (normalize(k) != target) put(k, v)
            }
            put(key, JsonPrimitive(true))
        }
        return commit(file, updated, projectPath, storeDir)
    }

    fun revoke(projectPath: String, storeDir: File = PiCliRunner.agentDir()): WriteResult {
        if (projectPath.isBlank()) return WriteResult(false, "project path is empty")
        val file = trustFile(storeDir)
        val current = try {
            readObjectOrNull(file)
        } catch (e: Exception) {
            return WriteResult(false, refuseMessage(file, e), snapshot(projectPath, storeDir))
        } ?: return WriteResult(true, null, snapshot(projectPath, storeDir)) // nothing to revoke

        val target = normalize(projectPath)
        val updated = buildJsonObject {
            current.forEach { (k, v) -> if (normalize(k) != target) put(k, v) }
        }
        if (updated.size == current.size) return WriteResult(true, null, snapshot(projectPath, storeDir))
        return commit(file, updated, projectPath, storeDir)
    }

    /** Key form pi itself writes: canonical, native separators. */
    private fun storedKey(projectPath: String): String =
        runCatching { File(projectPath).canonicalPath }.getOrElse { File(projectPath).absolutePath }

    private fun commit(
        file: File,
        updated: JsonObject,
        projectPath: String,
        storeDir: File,
    ): WriteResult {
        val text = try {
            outJson.encodeToString(JsonObject.serializer(), updated)
        } catch (e: Exception) {
            return WriteResult(false, "cannot serialise trust store: ${e.message}")
        }
        // Validate before touching the real file: a bad encode must never land.
        try {
            parseObject(text)
        } catch (e: Exception) {
            return WriteResult(false, "refusing to write invalid JSON: ${e.message}")
        }
        return try {
            file.parentFile?.mkdirs()
            if (file.isFile) {
                file.copyTo(File(file.parentFile, file.name + BACKUP_SUFFIX), overwrite = true)
            }
            val temp = File(file.parentFile, file.name + TEMP_SUFFIX)
            temp.writeText(text)
            moveAtomically(temp, file)
            WriteResult(true, null, snapshot(projectPath, storeDir))
        } catch (e: Exception) {
            WriteResult(false, "cannot write ${file.name}: ${e.message}")
        }
    }

    private fun moveAtomically(temp: File, target: File) {
        try {
            Files.move(
                temp.toPath(),
                target.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        } finally {
            // A failed move leaves the temp file behind; never accumulate them.
            if (temp.exists()) temp.delete()
        }
    }

    private fun refuseMessage(file: File, e: Exception): String =
        "${file.name} is not valid JSON (${e.message}); fix or delete it before trusting a project"

    // -- io helpers ---------------------------------------------------------

    private fun readTextOrNull(file: File): String? =
        if (!file.isFile) null else runCatching { file.readText() }.getOrNull()?.takeIf { it.isNotBlank() }

    /** Null when the file is missing or empty; throws when it does not parse. */
    private fun readObjectOrNull(file: File): JsonObject? {
        val text = readTextOrNull(file) ?: return null
        return parseObject(text)
    }

    private fun parseObject(text: String): JsonObject {
        val element = inJson.parseToJsonElement(text)
        return element as? JsonObject
            ?: throw IllegalArgumentException("expected a JSON object, got ${element::class.simpleName}")
    }
}
