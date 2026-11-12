package dev.pi.agent.manage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Duration
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * 027 — create/edit/delete custom providers in `models.json` (the "cc-switch"
 * flow): the plugin owns the provider section + its `models` array for the
 * provider being edited and must leave everything else byte-for-byte intact.
 *
 * Schema alignment is verbatim pi 1.5.0 (`ProviderConfigSchema` /
 * `ModelDefinitionSchema`): `api` has four values, `thinkingLevelMap[level]`
 * is the wire string for that level or `null` = unsupported
 * (`virtual-models.js`: `map[level] = levels.includes(level) ? level : null`),
 * `input` is `["text"]` or `["text","image"]`.
 *
 * Hard rules (spec FR-004/FR-005/FR-007):
 *  - read-modify-write with a timestamped backup and an atomic replace;
 *    validation failures never touch the file;
 *  - a name that collides with a bundled provider (or an existing custom the
 *    caller did not confirm) is refused with `code:"builtin"|"exists"`;
 *  - `apiKey` never crosses the bridge — `providerGet` answers with
 *    `hasKey`/`keyMasked`, an edit that sends no key keeps the stored one.
 */
object PiModels {

    val API_FORMATS = setOf(
        "anthropic-messages",
        "openai-completions",
        "openai-responses",
        "google-generative-ai",
    )

    /** pi's `THINKING_LEVELS` order (virtual-models.js). */
    val THINKING_LEVELS = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")

    /** Same table the web dropdown ships (knownProviders.ts, pi 1.5.0 registry). */
    val BUILTIN_PROVIDERS = setOf(
        "amazon-bedrock", "ant-ling", "anthropic", "azure", "baseten", "cerebras",
        "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks",
        "github-copilot", "google", "google-vertex", "groq", "huggingface",
        "kimi-coding", "meta", "minimax", "minimax-cn", "mistral", "moonshotai",
        "moonshotai-cn", "nvidia", "openai", "openai-codex", "opencode",
        "opencode-go", "openrouter", "qwen-token-plan", "qwen-token-plan-cn",
        "qwen-token-plan-individual", "radius", "together", "typesafe",
        "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams",
        "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai", "zai-coding-cn",
    )

    private val NAME_RE = Regex("[a-z0-9-_.]{1,64}")
    private val json = Json { prettyPrint = true }

    private fun error(message: String, code: String? = null): JsonObject = buildJsonObject {
        put("ok", false)
        code?.let { put("code", it) }
        put("error", message)
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.int(key: String): Int? =
        (this[key] as? JsonPrimitive)?.content?.toIntOrNull()

    private fun JsonObject.bool(key: String): Boolean =
        (this[key] as? JsonPrimitive)?.booleanOrNull == true

    /**
     * FR-002: the checkbox list becomes pi's map — checked = same-named wire
     * string, unchecked = null. Unknown levels are ignored (defensive: the web
     * sends only table levels). `null` result = nothing but "off"/nothing
     * checked → the model is `reasoning:false` and the map must NOT be written.
     */
    fun buildThinkingLevelMap(levels: List<String>): JsonObject? {
        val checked = levels.filter { it in THINKING_LEVELS }.toSet()
        val anyReal = THINKING_LEVELS.any { it != "off" && it in checked }
        if (!anyReal) return null
        return buildJsonObject {
            THINKING_LEVELS.forEach { level ->
                put(level, if (level in checked) JsonPrimitive(level) else JsonPrimitive(null))
            }
        }
    }

    /** `true` when the map supports the level (wire string), `false` = explicit null, missing = unknown. */
    private fun mapSupports(map: JsonObject?, level: String): Boolean =
        (map?.get(level) as? JsonPrimitive)?.isString == true

    // ---------------------------------------------------------------- read

    fun providerGet(params: JsonObject, agentDir: File = PiCliRunner.agentDir()): JsonObject {
        val name = params.string("name") ?: return error("missing name")
        val file = File(agentDir, "models.json")
        if (!file.isFile) {
            return buildJsonObject {
                put("ok", true)
                put("exists", false)
                put("name", name)
                put("path", file.absolutePath)
            }
        }
        val root = try {
            Json.parseToJsonElement(file.readText()).jsonObject
        } catch (e: Exception) {
            return error("models.json is not valid JSON (${e.message})")
        }
        val provider = (root["providers"] as? JsonObject)?.get(name) as? JsonObject
            ?: return buildJsonObject {
                put("ok", true)
                put("exists", false)
                put("name", name)
                put("path", file.absolutePath)
            }

        val models = (provider["models"] as? JsonArray)?.mapNotNull { entry ->
            val m = entry as? JsonObject ?: return@mapNotNull null
            val id = m.string("id") ?: return@mapNotNull null
            buildJsonObject {
                put("id", id)
                m.string("name")?.let { put("name", it) }
                put("reasoning", (m["reasoning"] as? JsonPrimitive)?.booleanOrNull == true)
                put("inputImage", (m["input"] as? JsonArray)?.any { (it as? JsonPrimitive)?.content == "image" } == true)
                put(
                    "thinkingLevels",
                    JsonArray(THINKING_LEVELS.filter { mapSupports(m["thinkingLevelMap"] as? JsonObject, it) }.map { JsonPrimitive(it) }),
                )
                m.int("contextWindow")?.let { put("contextWindow", it) }
                m.int("maxTokens")?.let { put("maxTokens", it) }
            }
        } ?: emptyList()

        val key = provider.string("apiKey")
        return buildJsonObject {
            put("ok", true)
            put("exists", true)
            put("name", name)
            put("path", file.absolutePath)
            put(
                "provider",
                buildJsonObject {
                    put("name", name)
                    provider.string("name")?.let { put("displayName", it) }
                    provider.string("baseUrl")?.let { put("baseUrl", it) }
                    provider.string("api")?.let { put("api", it) }
                    put("models", JsonArray(models))
                    put("hasKey", key != null)
                    key?.let { put("keyMasked", maskKey(it)) }
                },
            )
        }
    }

    private fun maskKey(key: String): String =
        if (key.length <= 6) "•••" else "${key.take(3)}…${key.takeLast(2)}"

    // ---------------------------------------------------------------- save

    fun providerSave(params: JsonObject, agentDir: File = PiCliRunner.agentDir()): JsonObject {
        val form = params["provider"] as? JsonObject ?: return error("missing provider")
        val overwrite = params["overwrite"]?.let { (it as? JsonPrimitive)?.booleanOrNull == true } ?: false

        val name = form.string("name")?.trim() ?: ""
        if (!NAME_RE.matches(name)) {
            return error("provider name must match [a-z0-9-_.]{1,64}", code = "badName")
        }
        val api = form.string("api")
        if (api == null || api !in API_FORMATS) {
            return error("api must be one of: ${API_FORMATS.joinToString(", ")}", code = "badApi")
        }
        val baseUrl = form.string("baseUrl")?.trim() ?: ""
        if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
            return error("baseUrl must start with http(s)://", code = "badUrl")
        }

        val file = File(agentDir, "models.json")
        val root: JsonObject = if (!file.isFile) {
            buildJsonObject { put("providers", JsonObject(emptyMap())) }
        } else {
            try {
                Json.parseToJsonElement(file.readText()).jsonObject
            } catch (e: Exception) {
                return error("models.json is not valid JSON — fix it first (${e.message})")
            }
        }
        val providers = root["providers"] as? JsonObject ?: JsonObject(emptyMap())

        if (name in BUILTIN_PROVIDERS && !overwrite) {
            return error(
                "\"$name\" is a bundled pi provider — confirm to overwrite its models.json section",
                code = "builtin",
            )
        }
        val existing = providers[name] as? JsonObject
        if (existing != null && !overwrite) {
            return error("a custom provider named \"$name\" already exists", code = "exists")
        }

        val formModels = (form["models"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
        if (formModels.isEmpty()) {
            return error("at least one model id is required", code = "noModels")
        }
        val ids = formModels.mapNotNull { it.string("id")?.trim() }
        if (ids.any { it.isEmpty() } || ids.size != ids.toSet().size) {
            return error("model ids must be non-empty and unique", code = "badModel")
        }

        val modelsJson = buildJsonArray {
            for (m in formModels) {
                val id = m.string("id")!!.trim()
                // FR-004: unknown keys of a RETAINED model id survive the edit;
                // only the fields the form owns are overwritten.
                val base = ((existing?.get("models") as? JsonArray)?.mapNotNull { it as? JsonObject }
                    ?: emptyList()).firstOrNull { it.string("id") == id } ?: JsonObject(emptyMap())
                buildJsonObject {
                    base.forEach { (k, v) -> if (k != "thinkingLevelMap" && k != "input" && k != "reasoning") put(k, v) }
                    put("id", id)
                    m.string("name")?.takeIf { it.isNotBlank() }?.let { put("name", it) }
                    val levels = (m["thinkingLevels"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()
                    val map = buildThinkingLevelMap(levels)
                    put("reasoning", map != null)
                    map?.let { put("thinkingLevelMap", it) }
                    put("input", buildJsonArray {
                        add(JsonPrimitive("text"))
                        if (m.bool("inputImage")) add(JsonPrimitive("image"))
                    })
                    m.int("contextWindow")?.let { put("contextWindow", it) }
                    m.int("maxTokens")?.let { put("maxTokens", it) }
                }.let { add(it) }
            }
        }

        val key = form.string("apiKey")?.takeIf { it.isNotBlank() }
        val entry = buildJsonObject {
            // FR-004/FR-005: fields the form does not own (headers, compat, …)
            // survive both a create-over-confirmed and an edit.
            existing?.forEach { (k, v) ->
                if (k !in setOf("name", "baseUrl", "api", "models", "apiKey")) put(k, v)
            }
            form.string("displayName")?.takeIf { it.isNotBlank() }?.let { put("name", it) }
            put("baseUrl", baseUrl)
            put("api", api)
            when {
                key != null -> put("apiKey", key)
                existing?.containsKey("apiKey") == true -> put("apiKey", existing["apiKey"]!!)
            }
            put("models", modelsJson)
        }

        backup(file)
        val newRoot = buildJsonObject {
            root.forEach { (k, v) -> if (k != "providers") put(k, v) }
            put(
                "providers",
                buildJsonObject {
                    providers.forEach { (k, v) -> if (k != name) put(k, v) }
                    put(name, entry)
                },
            )
        }
        if (!atomicWrite(file, newRoot.toString())) {
            return error("models.json could not be written (atomic replace failed)")
        }
        return buildJsonObject {
            put("ok", true)
            put("name", name)
            put("path", file.absolutePath)
        }
    }

    fun providerDelete(params: JsonObject, agentDir: File = PiCliRunner.agentDir()): JsonObject {
        val name = params.string("name") ?: return error("missing name")
        if (name in BUILTIN_PROVIDERS) {
            return error("\"$name\" is a bundled pi provider — nothing to delete here", code = "builtin")
        }
        val file = File(agentDir, "models.json")
        if (!file.isFile) return error("models.json not found at ${file.absolutePath}")
        val root = try {
            Json.parseToJsonElement(file.readText()).jsonObject
        } catch (e: Exception) {
            return error("models.json is not valid JSON (${e.message})")
        }
        val providers = root["providers"] as? JsonObject
            ?: return error("models.json has no \"providers\" object")
        if (!providers.containsKey(name)) return error("no provider named \"$name\"")

        backup(file)
        val newRoot = buildJsonObject {
            root.forEach { (k, v) -> if (k != "providers") put(k, v) }
            put(
                "providers",
                buildJsonObject { providers.forEach { (k, v) -> if (k != name) put(k, v) } },
            )
        }
        if (!atomicWrite(file, newRoot.toString())) {
            return error("models.json could not be written (atomic replace failed)")
        }
        return buildJsonObject {
            put("ok", true)
            put("name", name)
            put("path", file.absolutePath)
        }
    }

    // ---------------------------------------------------------------- test

    /**
     * Q1: the reachability probe — one GET at `${baseUrl}/models`
     * (`/v1/models` for anthropic-messages) with the key in the provider's
     * auth header style. The key never appears in the response or the log.
     */
    fun providerTest(params: JsonObject, agentDir: File = PiCliRunner.agentDir()): JsonObject {
        val baseUrl = params.string("baseUrl")?.trim()?.removeSuffix("/") ?: return error("missing baseUrl")
        val api = params.string("api") ?: ""
        val key = params.string("apiKey")?.takeIf { it.isNotBlank() }
        val url = when (api) {
            "anthropic-messages" -> "$baseUrl/v1/models"
            else -> "$baseUrl/models"
        }
        val started = System.currentTimeMillis()
        return try {
            val builder = HttpRequest.newBuilder().uri(URI.create(url)).GET()
                .timeout(Duration.ofSeconds(10))
            if (key != null) {
                if (api == "anthropic-messages") {
                    builder.header("x-api-key", key).header("anthropic-version", "2023-06-01")
                } else {
                    builder.header("Authorization", "Bearer $key")
                }
            }
            val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
            val resp = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
            val ms = System.currentTimeMillis() - started
            val ok = resp.statusCode() in 200..299
            buildJsonObject {
                put("ok", ok)
                put("status", resp.statusCode())
                put("ms", ms)
                if (!ok) put("error", "HTTP ${resp.statusCode()}: ${resp.body().take(200)}")
            }
        } catch (e: Exception) {
            val ms = System.currentTimeMillis() - started
            buildJsonObject {
                put("ok", false)
                put("ms", ms)
                put("error", (e.message ?: e.javaClass.simpleName).take(200))
            }
        }
    }

    // ---------------------------------------------------------------- io

    private fun backup(file: File) {
        if (!file.isFile) return
        val stamp = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").format(LocalDateTime.now())
        val target = File(file.parentFile, "models.json.bak-$stamp")
        runCatching { Files.copy(file.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING) }
    }

    /** Temp file + atomic move; a half-written models.json is worse than none. */
    private fun atomicWrite(file: File, text: String): Boolean = runCatching {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.tmp-${System.nanoTime()}")
        Files.writeString(tmp.toPath(), text)
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        true
    }.getOrDefault(false)
}
