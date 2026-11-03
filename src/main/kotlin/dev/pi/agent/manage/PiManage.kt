package dev.pi.agent.manage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File

/**
 * Management operations for the Manage view. CLI-driven where pi offers
 * subcommands (mcp, packages), filesystem/JSON where that is the source of
 * truth (skills, settings). All results are tolerant JSON for the frontend.
 */
object PiManage {

    private val json = Json { ignoreUnknownKeys = true }

    // -- MCP -----------------------------------------------------------------

    /**
     * MCP servers as pi sees them.
     *
     * [projectPath] is the CLI's working directory: `pi mcp list` resolves
     * `.pi/mcp.json` from the cwd, so without it a project's own servers are
     * never listed (the child would inherit the IDE process cwd).
     */
    fun mcpList(projectPath: String? = null): JsonObject {
        val result = PiCliRunner.run(
            listOf("mcp", "list", "--json"),
            workingDir = projectPath?.takeIf { it.isNotBlank() }?.let { File(it) },
        )
        val parsed = PiCliRunner.parseJsonOrNull(result)
        if (parsed is JsonObject && parsed.containsKey("servers")) {
            return buildJsonObject {
                put("ok", result.success)
                put("raw", parsed)
                put("error", result.stderr.takeIf { it.isNotBlank() && !result.success } ?: "")
            }
        }
        // Non-JSON output (older pi): surface raw text.
        return buildJsonObject {
            put("ok", result.success)
            put("raw", buildJsonObject { put("servers", JsonArray(emptyList())); put("errors", JsonArray(emptyList())) })
            put("text", (result.stdout + "\n" + result.stderr).trim())
            put("error", if (result.success) "" else result.stderr)
        }
    }

    fun mcpAdd(params: JsonObject): JsonObject {
        val name = params.string("name") ?: return error("missing name")
        val args = mutableListOf("mcp", "add", name)
        params.string("url")?.let {
            args += listOf("--url", it)
        } ?: run {
            val command = params.string("command") ?: return error("missing command")
            args += listOf("--", command)
            params.array("args")?.forEach { args += it }
            params.objectEntries("env").forEach { (k, v) -> args += listOf("--env", "$k=$v") }
        }
        val local = params.boolean("local") == true
        if (local) args += "--local"
        // `--local` writes `<cwd>/.pi/mcp.json`, so the cwd has to be the project.
        val dir = if (local) params.string("projectPath")?.let { File(it) } else null
        return cliToElement(PiCliRunner.run(args, workingDir = dir))
    }

    fun mcpRemove(params: JsonObject): JsonObject {
        val name = params.string("name") ?: return error("missing name")
        val args = mutableListOf("mcp", "remove", name)
        val local = params.boolean("local") == true
        if (local) args += "--local"
        val dir = if (local) params.string("projectPath")?.let { File(it) } else null
        return cliToElement(PiCliRunner.run(args, workingDir = dir))
    }

    /**
     * Enables or disables a server by editing the file that defines it.
     *
     * pi has no `mcp enable|disable` subcommand, but it honours `enabled: false`
     * on an entry — so this is a config edit, not a removal. See [PiMcpConfig].
     */
    fun mcpSetEnabled(params: JsonObject): JsonObject {
        val name = params.string("name") ?: return error("missing name")
        val scope = params.string("scope") ?: PiMcpConfig.SCOPE_GLOBAL
        val enabled = params.boolean("enabled") ?: return error("missing enabled")
        val outcome = PiMcpConfig.setEnabled(
            name = name,
            scope = scope,
            enabled = enabled,
            projectPath = params.string("projectPath"),
        )
        return buildJsonObject {
            put("ok", outcome.ok)
            put("name", name)
            put("scope", scope)
            outcome.enabled?.let { put("enabled", it) }
            put("error", outcome.error ?: "")
            put("warning", outcome.warning ?: "")
        }
    }

    fun mcpLogin(params: JsonObject): JsonObject {
        val name = params.string("name") ?: return error("missing name")
        return cliToElement(PiCliRunner.run(listOf("mcp", "login", name, "--timeout", "120"), timeoutSeconds = 150))
    }

    fun mcpLogout(params: JsonObject): JsonObject {
        val name = params.string("name") ?: return error("missing name")
        return cliToElement(PiCliRunner.run(listOf("mcp", "logout", name)))
    }

    // -- Packages (extensions) ----------------------------------------------

    fun packagesList(): JsonObject {
        val result = PiCliRunner.run(listOf("list"))
        val lines = result.stdout.lines().filter { it.isNotBlank() }
        return buildJsonObject {
            put("ok", result.success)
            put("lines", JsonArray(lines.map { JsonPrimitive(it) }))
            put("error", if (result.success) "" else result.stderr)
        }
    }

    fun packageInstall(params: JsonObject): JsonObject {
        val source = params.string("source") ?: return error("missing source")
        val args = mutableListOf("install", source)
        if (params.boolean("local") == true) args += "--local"
        return cliToElement(PiCliRunner.run(args, timeoutSeconds = 300))
    }

    fun packageRemove(params: JsonObject): JsonObject {
        val source = params.string("source") ?: return error("missing source")
        return cliToElement(PiCliRunner.run(listOf("remove", source)))
    }

    /**
     * `pi update <source>` — the TUI command already reports the outcome
     * ("updated to x.y.z" / "already up to date") in its own output, so the
     * plugin forwards stdout+stderr verbatim instead of diffing install state
     * to guess whether anything changed. Timeout matches [packageInstall].
     */
    fun packageUpdate(
        params: JsonObject,
        runner: (List<String>, Long) -> CliResult = ::defaultRunner,
    ): JsonObject {
        val source = params.string("source") ?: return error("missing source")
        return cliToElement(runner(packageUpdateArgs(source), UPDATE_TIMEOUT_SECONDS))
    }

    // -- Skills --------------------------------------------------------------

    /**
     * Lists skills from the user dir and — when [projectBasePath] is known —
     * from the project's own `.pi/skills` and `.agents/skills`.
     *
     * The project dirs used to be resolved as `File(".pi/skills")`, i.e.
     * relative to the *IDE process* working directory rather than the project
     * root: multi-project windows listed the wrong project's skills (or none).
     */
    fun skillsList(projectBasePath: String? = null): JsonObject {
        data class Source(val dir: File, val scope: String)

        val sources = buildList {
            add(Source(File(PiCliRunner.agentDir(), "skills"), "user"))
            projectBasePath?.takeIf { it.isNotBlank() }?.let { base ->
                val root = File(base)
                add(Source(File(root, ".pi/skills"), "project"))
                add(Source(File(root, ".agents/skills"), "project"))
            }
        }
        val skills = mutableListOf<JsonObject>()
        // The same directory can be reachable twice (symlinked .agents/skills);
        // dedupe on the resolved SKILL.md so it is listed once.
        val seen = mutableSetOf<String>()
        for (source in sources) {
            if (!source.dir.isDirectory) continue
            source.dir.walkTopDown()
                .filter { it.name == "SKILL.md" && it.isFile }
                .forEach { file ->
                    val key = runCatching { file.canonicalPath }.getOrElse { file.absolutePath }
                    if (!seen.add(key)) return@forEach
                    val front = parseFrontmatter(file)
                    skills.add(buildJsonObject {
                        put("name", front["name"] ?: file.parentFile.name)
                        put("description", front["description"] ?: "")
                        put("path", file.parentFile.absolutePath)
                        put("scope", source.scope)
                        put("disableModelInvocation", front["disable-model-invocation"] == "true")
                    })
                }
        }
        return buildJsonObject {
            put("ok", true)
            put("skills", JsonArray(skills))
        }
    }

    /** Creates a skill from a template in the user skills directory. */
    fun skillCreate(params: JsonObject): JsonObject {
        val name = params.string("name")
            ?: return error("missing name")
        if (!Regex("[a-z0-9](-?[a-z0-9])*").matches(name) || name.length > 64) {
            return error("invalid skill name (lowercase letters, digits, hyphens)")
        }
        val dir = File(PiCliRunner.agentDir(), "skills/$name")
        if (dir.exists()) return error("skill already exists: $name")
        val description = params.string("description") ?: "Describe when this skill applies."
        val body = params.string("body") ?: "# $name\n\nInstructions for the model…\n"
        dir.mkdirs()
        File(dir, "SKILL.md").writeText(
            "---\nname: $name\ndescription: $description\n---\n\n$body",
        )
        return buildJsonObject { put("ok", true); put("path", dir.absolutePath) }
    }

    private fun parseFrontmatter(file: File): Map<String, String> {
        val map = mutableMapOf<String, String>()
        try {
            file.useLines { lines ->
                var inFront = false
                for (line in lines.take(40)) {
                    val trimmed = line.trim()
                    if (trimmed == "---") {
                        if (!inFront) inFront = true else break
                        continue
                    }
                    if (!inFront) {
                        if (trimmed.isEmpty()) continue else break
                    }
                    val idx = trimmed.indexOf(':')
                    if (idx > 0) {
                        map[trimmed.substring(0, idx).trim()] = trimmed.substring(idx + 1).trim().trim('"')
                    }
                }
            }
        } catch (_: Exception) {
        }
        return map
    }

    // -- Auth ----------------------------------------------------------------

    /**
     * Provider overview. `modelsState` distinguishes the three models.json
     * worlds the Auth panel must tell apart (spec 001 FR-013): "ok", "missing"
     * (nothing configured yet — not an error) and "corrupt" (parse failure,
     * reported with the position instead of an empty panel).
     */
    fun authOverview(agentDir: File = PiCliRunner.agentDir()): JsonObject {
        val authFile = File(agentDir, "auth.json")
        val providersWithCreds = try {
            (json.parseToJsonElement(authFile.readText()) as? JsonObject)?.keys ?: emptySet()
        } catch (_: Exception) {
            emptySet()
        }
        val modelsFile = File(agentDir, "models.json")
        var modelsState = "ok"
        var modelsError: String? = null
        val customProviders = try {
            ((json.parseToJsonElement(modelsFile.readText()) as? JsonObject)
                ?.get("providers") as? JsonObject)?.keys ?: emptySet()
        } catch (e: Exception) {
            if (modelsFile.isFile) {
                modelsState = "corrupt"
                modelsError = "models.json is not valid JSON (${e.message})"
            } else {
                modelsState = "missing"
            }
            emptySet()
        }
        val names = (providersWithCreds + customProviders).toSortedSet()
        return buildJsonObject {
            put("ok", true)
            put("providers", JsonArray(names.map { JsonPrimitive(it) }))
            put("withCredentials", JsonArray(providersWithCreds.sorted().map { JsonPrimitive(it) }))
            put("modelsState", modelsState)
            put("modelsPath", modelsFile.absolutePath)
            modelsError?.let { put("modelsError", it) }
        }
    }

    fun authCheck(params: JsonObject): JsonObject {
        val provider = params.string("provider") ?: return error("missing provider")
        val result = PiCliRunner.run(
            listOf("auth", "check", "--provider", provider, "--json", "--no-refresh"),
            timeoutSeconds = 30,
        )
        val status = when {
            result.exitCode == 0 -> "ready"
            result.exitCode == 2 -> "invalid"
            else -> "not_ready"
        }
        val parsed = PiCliRunner.parseJsonOrNull(result)
        return buildJsonObject {
            put("ok", result.success)
            put("provider", provider)
            put("status", status)
            put("detail", parsed ?: JsonPrimitive((result.stdout + result.stderr).trim().take(400)))
        }
    }

    // -- Settings ------------------------------------------------------------

    fun settingsRead(): JsonObject {
        val file = File(PiCliRunner.agentDir(), "settings.json")
        val text = if (file.isFile) file.readText() else "{}"
        val parsed = try {
            json.parseToJsonElement(text)
        } catch (_: Exception) {
            JsonPrimitive("{}")
        }
        return buildJsonObject {
            put("ok", true)
            put("path", file.absolutePath)
            put("text", text)
            put("json", parsed)
        }
    }

    fun settingsWrite(params: JsonObject): JsonObject {
        val text = params.string("text") ?: return error("missing text")
        try {
            json.parseToJsonElement(text)
        } catch (e: Exception) {
            return error("invalid JSON: ${e.message}")
        }
        val file = File(PiCliRunner.agentDir(), "settings.json")
        if (file.exists()) {
            file.copyTo(File(file.parentFile, "settings.json.bak"), overwrite = true)
        }
        file.parentFile.mkdirs()
        file.writeText(text)
        return buildJsonObject { put("ok", true); put("path", file.absolutePath) }
    }

    // -- Environment ---------------------------------------------------------

    fun environment(): JsonObject {
        val install = dev.pi.agent.process.PiLocator.locate(forceRefresh = true)
        return buildJsonObject {
            put("ok", true)
            put("found", install != null)
            put("path", install?.path ?: "")
            put("version", install?.version ?: "")
            put("agentDir", PiCliRunner.agentDir().absolutePath)
        }
    }

    /**
     * `pi update --self` (T015). On success the located installation is
     * refreshed so the version the UI shows comes from the new binary (T018);
     * pi has no check-update subcommand, so "already newest" is whatever the
     * command's own output says — the plugin never guesses it.
     */
    fun envUpdate(
        runner: (List<String>, Long) -> CliResult = ::defaultRunner,
        refresh: () -> Unit = { dev.pi.agent.process.PiLocator.locate(forceRefresh = true) },
        currentVersion: () -> String? = { dev.pi.agent.process.PiLocator.locate()?.version },
    ): JsonObject {
        val result = runner(envUpdateArgs(), UPDATE_TIMEOUT_SECONDS)
        if (result.success) refresh()
        return buildJsonObject {
            put("ok", result.success)
            put("exitCode", result.exitCode)
            put("output", (result.stdout + "\n" + result.stderr).trim().take(2000))
            put("version", currentVersion() ?: "")
        }
    }

    // -- Provider configuration (models.json) --------------------------------

    /** Outcome of [modelsEnsureFile]. */
    data class ModelsFileOutcome(val file: File, val created: Boolean, val error: String? = null)

    /**
     * models.json path, creating the `{"providers": {}}` skeleton when absent
     * (T020). An existing file is never touched here: "open in editor" must
     * not be able to reset a configuration that only failed to parse.
     */
    fun modelsEnsureFile(agentDir: File = PiCliRunner.agentDir()): ModelsFileOutcome {
        val file = File(agentDir, "models.json")
        if (file.isFile) return ModelsFileOutcome(file, created = false)
        return try {
            file.parentFile.mkdirs()
            file.writeText("{\n  \"providers\": {}\n}")
            ModelsFileOutcome(file, created = true)
        } catch (e: Exception) {
            ModelsFileOutcome(file, created = false, error = "could not create models.json: ${e.message}")
        }
    }

    /** 1-based line of the provider's key in models.json, for editor navigation. */
    fun modelsProviderLine(file: File, provider: String?): Int {
        if (provider.isNullOrBlank()) return 1
        return runCatching {
            val idx = file.readLines().indexOfFirst { it.contains("\"$provider\"") }
            if (idx >= 0) idx + 1 else 1
        }.getOrDefault(1)
    }

    /**
     * One provider entry from models.json with every sensitive value replaced
     * by a boolean (T019, reverse whitelist): unknown keys pass through so a
     * pi schema change cannot silently hide configuration, and secret values
     * cannot leak because the raw string is dropped at this boundary. The
     * hard assertion in PiManageProviderTest pins that the raw secret never
     * appears anywhere in the returned JSON.
     */
    fun modelsReadProvider(params: JsonObject, agentDir: File = PiCliRunner.agentDir()): JsonObject {
        val name = params.string("name") ?: return error("missing name")
        val file = File(agentDir, "models.json")
        if (!file.isFile) {
            return buildJsonObject {
                put("ok", false)
                put("name", name)
                put("path", file.absolutePath)
                put("missing", true)
                put("error", "models.json not found at ${file.absolutePath}")
            }
        }
        val text = try {
            file.readText()
        } catch (e: Exception) {
            return error("models.json could not be read: ${e.message}")
        }
        val root = try {
            json.parseToJsonElement(text).jsonObject
        } catch (e: Exception) {
            return error("models.json is not valid JSON (${withParsePosition(text, e.message ?: "")})")
        }
        val providers = root["providers"] as? JsonObject
            ?: return error("models.json has no \"providers\" object")
        val provider = providers[name] as? JsonObject
            ?: return error("no provider named \"$name\" in models.json")
        return buildJsonObject {
            put("ok", true)
            put("name", name)
            put("path", file.absolutePath)
            put("config", sanitize(provider))
        }
    }

    /** Keys whose value must never reach the frontend (matched lowercase). */
    private val SENSITIVE_KEYS = setOf(
        "apikey", "api_key", "accesstoken", "access_token", "refreshtoken",
        "refresh_token", "clientsecret", "client_secret", "password", "secret",
        "token", "credentials",
    )

    /**
     * Inside a `headers` object the sensitive part is the header name, so the
     * key set differs (`headers` itself is not secret).
     */
    private val SENSITIVE_HEADER_KEYS = setOf(
        "authorization", "proxy-authorization", "cookie", "x-api-key", "x-auth-token",
    )

    private fun sanitize(value: JsonElement, inHeaders: Boolean = false): JsonElement = when (value) {
        is JsonObject -> buildJsonObject {
            value.forEach { (key, child) ->
                val lower = key.lowercase()
                if ((inHeaders && lower in SENSITIVE_HEADER_KEYS) || lower in SENSITIVE_KEYS) {
                    put(key, isConfigured(child))
                } else {
                    put(key, sanitize(child, inHeaders = inHeaders || lower == "headers"))
                }
            }
        }
        is JsonArray -> buildJsonArray { value.forEach { add(sanitize(it, inHeaders)) } }
        else -> value
    }

    /** True when a sensitive key holds a non-empty value; only the flag travels. */
    private fun isConfigured(value: JsonElement): Boolean = when {
        value is JsonNull -> false
        // A JSON number/boolean counts as configured; an empty string does not.
        value is JsonPrimitive -> !value.isString || value.content.isNotBlank()
        value is JsonObject -> value.isNotEmpty()
        value is JsonArray -> value.isNotEmpty()
        else -> false
    }

    /** Appends line/column to a parser message that mentions a byte offset. */
    private fun withParsePosition(text: String, message: String): String {
        val offset = Regex("offset (\\d+)").find(message)?.groupValues?.get(1)?.toIntOrNull()
            ?: return message
        val before = text.substring(0, offset.coerceAtMost(text.length))
        val line = before.count { it == '\n' } + 1
        val lastBreak = before.lastIndexOf('\n')
        val column = if (lastBreak < 0) offset + 1 else offset - lastBreak
        return "$message (line $line, column $column)"
    }

    // -- helpers -------------------------------------------------------------

    /** Updates can legitimately take minutes (npm registry round-trips). */
    internal const val UPDATE_TIMEOUT_SECONDS = 300L

    internal fun packageUpdateArgs(source: String): List<String> = listOf("update", source)

    internal fun envUpdateArgs(): List<String> = listOf("update", "--self")

    private fun defaultRunner(args: List<String>, timeoutSeconds: Long): CliResult =
        PiCliRunner.run(args, timeoutSeconds = timeoutSeconds)

    private fun cliToElement(result: CliResult): JsonObject = buildJsonObject {
        put("ok", result.success)
        put("exitCode", result.exitCode)
        put("output", (result.stdout + result.stderr).trim().take(2000))
    }

    private fun error(message: String): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", message)
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.boolean(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.content?.toBooleanStrictOrNull()

    private fun JsonObject.array(key: String): List<String>? =
        (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }

    private fun JsonObject.objectEntries(key: String): Map<String, String> =
        (this[key] as? JsonObject)?.mapValues { (_, v) -> (v as? JsonPrimitive)?.content ?: "" } ?: emptyMap()
}
