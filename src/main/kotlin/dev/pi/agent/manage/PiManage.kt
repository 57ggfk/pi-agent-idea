package dev.pi.agent.manage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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

    fun mcpList(): JsonObject {
        val result = PiCliRunner.run(listOf("mcp", "list", "--json"))
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
        if (params.boolean("local") == true) args += "--local"
        val result = PiCliRunner.run(args)
        return cliToElement(result)
    }

    fun mcpRemove(params: JsonObject): JsonObject {
        val name = params.string("name") ?: return error("missing name")
        val args = mutableListOf("mcp", "remove", name)
        if (params.boolean("local") == true) args += "--local"
        return cliToElement(PiCliRunner.run(args))
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

    // -- Skills --------------------------------------------------------------

    fun skillsList(): JsonObject {
        val dirs = listOf(
            File(PiCliRunner.agentDir(), "skills"),
            File(".pi/skills"),
            File(".agents/skills"),
        )
        val skills = mutableListOf<JsonObject>()
        for (dir in dirs) {
            if (!dir.isDirectory) continue
            dir.walkTopDown()
                .filter { it.name == "SKILL.md" && it.isFile }
                .forEach { file ->
                    val front = parseFrontmatter(file)
                    skills.add(buildJsonObject {
                        put("name", front["name"] ?: file.parentFile.name)
                        put("description", front["description"] ?: "")
                        put("path", file.parentFile.absolutePath)
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

    fun authOverview(): JsonObject {
        val authFile = File(PiCliRunner.agentDir(), "auth.json")
        val providersWithCreds = try {
            (json.parseToJsonElement(authFile.readText()) as? JsonObject)?.keys ?: emptySet()
        } catch (_: Exception) {
            emptySet()
        }
        val customProviders = try {
            val modelsFile = File(PiCliRunner.agentDir(), "models.json")
            ((json.parseToJsonElement(modelsFile.readText()) as? JsonObject)
                ?.get("providers") as? JsonObject)?.keys ?: emptySet()
        } catch (_: Exception) {
            emptySet()
        }
        val names = (providersWithCreds + customProviders).toSortedSet()
        return buildJsonObject {
            put("ok", true)
            put("providers", JsonArray(names.map { JsonPrimitive(it) }))
            put("withCredentials", JsonArray(providersWithCreds.sorted().map { JsonPrimitive(it) }))
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

    // -- helpers -------------------------------------------------------------

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
