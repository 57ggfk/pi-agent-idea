package dev.pi.agent.manage

import com.intellij.openapi.diagnostic.Logger
import dev.pi.agent.process.PiTrust
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Reader/writer for pi's MCP configuration files.
 *
 * pi 1.4.0 has no `mcp enable|disable` subcommand, but it *does* honour an
 * optional `enabled` field on a server entry — `docs/mcp.md`: “`enabled: false`:
 * keep the entry without connecting to it”, and `pi mcp list --json` already
 * reports such entries with `"state": "disabled"`. So disabling is an in-place
 * edit of the file that *defines* the server: the command, args and env stay
 * exactly where the user put them, which is the whole point of spec 001 US1.
 *
 * (An earlier design moved the entry into a plugin-side “disabled store”. That
 * was based on the wrong assumption that pi ignores unknown fields; it also
 * invented a second source of truth that could drift from the file. Dropped.)
 *
 * A project entry without `command` / `url` / `type` is an *override*: it only
 * replaces `enabled` / `exposure` / `toolExposure` of the user-level server
 * with the same name. Writing a user-level change therefore does not
 * necessarily change what the project sees, so [setEnabled] reports a warning
 * instead of pretending the switch took effect everywhere.
 */
object PiMcpConfig {

    private val LOG = Logger.getInstance(PiMcpConfig::class.java)

    const val SCOPE_GLOBAL = "global"
    const val SCOPE_PROJECT = "project"

    /** Root key pi reads, matching other MCP clients. */
    private const val SERVERS_KEY = "mcpServers"

    private const val BACKUP_SUFFIX = ".bak"
    private const val TEMP_SUFFIX = ".tmp"

    /** Same shape `pi mcp add` writes, so a hand-edited diff stays readable. */
    private val outJson = Json { prettyPrint = true; prettyPrintIndent = "  " }
    private val inJson = Json

    data class Outcome(
        val ok: Boolean,
        val error: String? = null,
        /**
         * Non-fatal truth the UI must show next to the switch: the write landed
         * but another layer still decides the effective value.
         */
        val warning: String? = null,
        /** Effective value after the write, for the caller to echo back. */
        val enabled: Boolean? = null,
    )

    /** One configured server as it appears in a single file. */
    data class Entry(val name: String, val enabled: Boolean, val definesServer: Boolean)

    // -- paths ---------------------------------------------------------------

    fun fileFor(scope: String, projectPath: String?, agentDir: File = PiCliRunner.agentDir()): File? =
        if (scope == SCOPE_PROJECT) {
            projectPath?.takeIf { it.isNotBlank() }?.let { File(File(it), ".pi/mcp.json") }
        } else {
            File(agentDir, "mcp.json")
        }

    // -- read ----------------------------------------------------------------

    /** Servers defined in [scope]'s file, in file order. Empty when unreadable. */
    fun entries(scope: String, projectPath: String?, agentDir: File = PiCliRunner.agentDir()): List<Entry> {
        val file = fileFor(scope, projectPath, agentDir) ?: return emptyList()
        val servers = runCatching { readServers(file) }.getOrNull() ?: return emptyList()
        return servers.mapNotNull { (name, value) ->
            val obj = value as? JsonObject ?: return@mapNotNull null
            Entry(
                name = name,
                enabled = isEnabled(obj),
                definesServer = obj.containsKey("command") || obj.containsKey("url") || obj.containsKey("type"),
            )
        }
    }

    /** `enabled` defaults to true: the field is optional in pi's schema. */
    private fun isEnabled(entry: JsonObject): Boolean {
        val raw = (entry["enabled"] as? JsonPrimitive)?.contentOrNull ?: return true
        return raw.toBooleanStrictOrNull() ?: true
    }

    // -- write ---------------------------------------------------------------

    /**
     * Enables or disables [name] in the file that defines it.
     *
     * `enabled = true` removes the field rather than writing `true`: pi treats a
     * missing field as enabled, so removing keeps the file free of noise and
     * makes a re-disable a one-key diff again.
     */
    fun setEnabled(
        name: String,
        scope: String,
        enabled: Boolean,
        projectPath: String?,
        agentDir: File = PiCliRunner.agentDir(),
    ): Outcome {
        if (name.isBlank()) return Outcome(false, "missing name")
        if (scope != SCOPE_GLOBAL && scope != SCOPE_PROJECT) {
            return Outcome(false, "unknown scope: $scope")
        }
        val file = fileFor(scope, projectPath, agentDir)
            ?: return Outcome(false, "project path is unknown; cannot edit .pi/mcp.json")

        // Writing a file pi never reads would look like it worked. Refuse, and
        // say why (spec 001 T011).
        if (scope == SCOPE_PROJECT && !PiTrust.isTrusted(projectPath, agentDir)) {
            return Outcome(
                false,
                "project is not trusted, so pi ignores .pi/mcp.json — trust the project first",
            )
        }

        if (!file.isFile) {
            return Outcome(false, "${file.name} does not exist, so there is nothing to enable or disable")
        }
        val root = try {
            parseObject(file.readText())
        } catch (e: Exception) {
            return Outcome(false, refuseMessage(file, e))
        }
        val servers = root[SERVERS_KEY] as? JsonObject
            ?: return Outcome(false, "${file.name} has no \"$SERVERS_KEY\" object")
        val current = servers[name] as? JsonObject
            ?: return Outcome(false, "no MCP server named \"$name\" in ${file.name}")

        val updatedEntry = buildJsonObject {
            current.forEach { (k, v) -> if (k != "enabled") put(k, v) }
            if (!enabled) put("enabled", JsonPrimitive(false))
        }
        if (updatedEntry == current) {
            // Already in the requested state: touch nothing, write no backup.
            return Outcome(true, enabled = enabled, warning = overrideWarning(name, scope, enabled, projectPath, agentDir))
        }
        val updatedRoot = buildJsonObject {
            root.forEach { (k, v) ->
                if (k != SERVERS_KEY) {
                    put(k, v)
                } else {
                    put(SERVERS_KEY, buildJsonObject {
                        servers.forEach { (serverName, entry) ->
                            put(serverName, if (serverName == name) updatedEntry else entry)
                        }
                    })
                }
            }
        }
        val failure = commit(file, updatedRoot)
        if (failure != null) return Outcome(false, failure)
        return Outcome(true, enabled = enabled, warning = overrideWarning(name, scope, enabled, projectPath, agentDir))
    }

    /**
     * Tells the caller when the *other* layer still decides the effective value.
     * Silence here would recreate the bug the spec's edge cases describe: “the
     * user-level switch says off while the project keeps the server running”.
     */
    private fun overrideWarning(
        name: String,
        scope: String,
        enabled: Boolean,
        projectPath: String?,
        agentDir: File,
    ): String? {
        val otherScope = if (scope == SCOPE_GLOBAL) SCOPE_PROJECT else SCOPE_GLOBAL
        if (otherScope == SCOPE_PROJECT && (projectPath.isNullOrBlank() || !PiTrust.isTrusted(projectPath, agentDir))) {
            return null
        }
        val other = entries(otherScope, projectPath, agentDir).firstOrNull { it.name == name } ?: return null
        if (other.enabled == enabled) return null
        return if (otherScope == SCOPE_PROJECT) {
            "This project's .pi/mcp.json overrides the setting; the server stays " +
                "${if (other.enabled) "enabled" else "disabled"} here."
        } else {
            "The user-level mcp.json sets a different value, but project overrides do not apply here."
        }
    }

    // -- io ------------------------------------------------------------------

    private fun readServers(file: File): JsonObject? =
        (parseObject(file.readText())[SERVERS_KEY]) as? JsonObject

    private fun parseObject(text: String): JsonObject {
        val element = inJson.parseToJsonElement(text)
        return element as? JsonObject
            ?: throw IllegalArgumentException("expected a JSON object, got ${element::class.simpleName}")
    }

    /**
     * Backup → validate → atomic move, mirroring [PiTrust]: the file is shared
     * with the CLI, so a malformed write would break `pi` in the terminal too.
     * Returns an error message, or null on success.
     */
    private fun commit(file: File, updated: JsonObject): String? {
        val text = try {
            outJson.encodeToString(JsonObject.serializer(), updated)
        } catch (e: Exception) {
            return "cannot serialise ${file.name}: ${e.message}"
        }
        try {
            parseObject(text)
        } catch (e: Exception) {
            return "refusing to write invalid JSON: ${e.message}"
        }
        return try {
            file.parentFile?.mkdirs()
            file.copyTo(File(file.parentFile, file.name + BACKUP_SUFFIX), overwrite = true)
            val temp = File(file.parentFile, file.name + TEMP_SUFFIX)
            temp.writeText(text)
            moveAtomically(temp, file)
            null
        } catch (e: Exception) {
            LOG.warn("cannot write ${file.name}", e)
            "cannot write ${file.name}: ${e.message}"
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
            if (temp.exists()) temp.delete()
        }
    }

    private fun refuseMessage(file: File, e: Exception): String =
        "${file.name} is not valid JSON (${e.message}); fix or delete it before changing MCP servers"
}
