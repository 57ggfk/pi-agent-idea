package dev.pi.agent.manage

import dev.pi.agent.process.OsProcess
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions

/**
 * Credential write/delete (012 US5/US6, T127).
 *
 * T103 evidence: pi 1.4.0 has NO official write command or RPC — credentials
 * live in two files the plugin may write directly:
 *
 *  - `~/.pi/agent/auth.json` — `{ [providerId]: {type:"api_key", key} }`.
 *    pi reads it with a strict schema (one bad entry rejects the whole file)
 *    and REWRITES it under a `proper-lockfile` directory lock when OAuth
 *    tokens refresh, so the plugin must take the same kind of lock before
 *    touching it.
 *  - `~/.pi/agent/models.json` — custom providers carry `apiKey` directly;
 *    pi only READS this file, so a plain atomic replace is enough.
 *
 * Hard rules (plan D3): responses and logs carry the provider name only,
 * never the key; a corrupt target file is an error, never overwritten.
 */
object PiCredentials {

    private val PROVIDER_RE = Regex("[a-zA-Z0-9_-]{1,64}")

    private const val LOCK_RETRIES = 10
    private const val LOCK_RETRY_MS = 20L
    /** proper-lockfile treats locks older than this as stale; so do we. */
    private const val LOCK_STALE_MS = 30_000L

    fun authSet(params: JsonObject, agentDir: File = PiCliRunner.agentDir()): JsonObject =
        mutateAuth(agentDir, params, requireKey = true) { auth, provider, key ->
            auth + (provider to buildJsonObject {
                put("type", "api_key")
                put("key", key)
            })
        }

    fun authDelete(params: JsonObject, agentDir: File = PiCliRunner.agentDir()): JsonObject =
        mutateAuth(agentDir, params, requireKey = false) { auth, provider, _ ->
            auth - provider
        }

    /**
     * Sets `providers.<name>.apiKey` in models.json. The provider entry must
     * already exist (defined through the editor per the Q3 fallback): the
     * plugin only fills the key, it does not build provider configs.
     */
    fun providerSetKey(params: JsonObject, agentDir: File = PiCliRunner.agentDir()): JsonObject {
        val (provider, key, failure) = validated(params, requireKey = true)
        if (failure != null) return failure

        val file = File(agentDir, "models.json")
        val root: JsonObject = try {
            readJson(file) ?: buildJsonObject { put("providers", JsonObject(emptyMap())) }
        } catch (e: Exception) {
            return error("models.json is not valid JSON — fix it in the editor first (${e.message})")
        }
        val providers = (root["providers"] as? JsonObject)
            ?: return error("models.json has no providers object")
        val entry = providers[provider] as? JsonObject
            ?: return error("no provider named \"$provider\" in models.json — add it in the editor first")

        val updated = buildJsonObject {
            root.forEach { (k, v) -> put(k, v) }
            put(
                "providers",
                buildJsonObject {
                    providers.forEach { (k, v) -> if (k != provider) put(k, v) }
                    put(provider, buildJsonObject { entry.forEach { (k, v) -> if (k != "apiKey") put(k, v) }; put("apiKey", key) })
                },
            )
        }
        return try {
            atomicWrite(file, jsonText(updated))
            verify(file) { obj ->
                ((obj["providers"] as? JsonObject)?.get(provider) as? JsonObject)
                    ?.get("apiKey") == JsonPrimitive(key)
            }
            ok(provider)
        } catch (e: Exception) {
            error("could not write models.json: ${e.message}")
        }
    }

    // -- auth.json ------------------------------------------------------------

    private fun mutateAuth(
        agentDir: File,
        params: JsonObject,
        requireKey: Boolean,
        mutate: (Map<String, JsonObject>, String, String) -> Map<String, JsonObject>,
    ): JsonObject {
        val (provider, key, failure) = validated(params, requireKey)
        if (failure != null) return failure

        val file = File(agentDir, "auth.json")
        val lock = File(agentDir, "auth.json.lock")
        if (!takeLock(lock)) {
            return error("auth.json is locked by another process (or a stale lock is present) — try again in a moment")
        }
        try {
            val current: Map<String, JsonObject> = try {
                (readJson(file) as? JsonObject)?.mapValues { (_, v) ->
                    v as? JsonObject ?: JsonObject(emptyMap())
                } ?: emptyMap()
            } catch (e: Exception) {
                // A corrupt file must never be silently overwritten.
                return error("auth.json is not valid JSON — fix or remove it first (${e.message})")
            }
            val next = mutate(current, provider, key)
            val text = jsonText(JsonObject(next))
            Files.write(file.toPath(), text.toByteArray(StandardCharsets.UTF_8))
            restrictPermissions(file.toPath())
            verify(file) { obj -> obj.keys.contains(provider) == (provider in next) }
            return ok(provider)
        } catch (e: Exception) {
            return error("could not write auth.json: ${e.message}")
        } finally {
            releaseLock(lock)
        }
    }

    /** Reproduces the `proper-lockfile` protocol: the lock is a DIRECTORY,
     *  taken atomically; a lock older than the staleness window is broken. */
    private fun takeLock(lock: File): Boolean {
        repeat(LOCK_RETRIES) {
            if (lock.exists()) {
                if (System.currentTimeMillis() - lock.lastModified() > LOCK_STALE_MS) {
                    lock.deleteRecursively()
                    return@repeat
                }
                Thread.sleep(LOCK_RETRY_MS)
            }
        }
        return runCatching { Files.createDirectory(lock.toPath()); true }
            .recoverCatching { e ->
                // The retry loop above may have just freed it.
                if (lock.exists() && System.currentTimeMillis() - lock.lastModified() > LOCK_STALE_MS) {
                    lock.deleteRecursively()
                    Files.createDirectory(lock.toPath())
                    true
                } else {
                    throw e
                }
            }
            .getOrDefault(false)
    }

    private fun releaseLock(lock: File) {
        runCatching { lock.deleteRecursively() }
    }

    // -- shared helpers -------------------------------------------------------

    private fun validated(params: JsonObject, requireKey: Boolean): Triple<String, String, JsonObject?> {
        val provider = (params["provider"] as? JsonPrimitive)?.content?.trim() ?: ""
        if (!PROVIDER_RE.matches(provider)) {
            return Triple("", "", error("invalid provider name (letters, digits, - and _, up to 64 chars)"))
        }
        val key = if (requireKey) (params["key"] as? JsonPrimitive)?.content?.trim() ?: "" else ""
        if (requireKey && (key.isEmpty() || key.length > 4096)) {
            return Triple("", "", error("missing or oversized API key"))
        }
        return Triple(provider, key, null)
    }

    /** BOM-tolerant read; returns null when the file is absent. */
    private fun readJson(file: File): JsonObject? {
        if (!file.isFile) return null
        val text = file.readText(StandardCharsets.UTF_8).removePrefix("\uFEFF")
        return PiManageJson.parse(text)
    }

    private fun jsonText(obj: JsonObject): String = PiManageJson.text(obj)

    /** Re-reads what we just wrote: the write only "counted" when the file
     *  parses again and [check] holds. Never logs the payload. */
    private fun verify(file: File, check: (JsonObject) -> Boolean) {
        val obj = readJson(file) ?: throw IllegalStateException("written file does not parse: ${file.name}")
        if (!check(obj)) throw IllegalStateException("written file failed verification: ${file.name}")
    }

    private fun atomicWrite(file: File, text: String) {
        val tmp = Files.createTempFile(file.parentFile.toPath(), file.name, ".tmp")
        Files.write(tmp, text.toByteArray(StandardCharsets.UTF_8))
        restrictPermissions(tmp)
        runCatching { Files.move(tmp, file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE) }
            .recoverCatching { Files.move(tmp, file.toPath(), StandardCopyOption.REPLACE_EXISTING) }
    }

    private fun restrictPermissions(path: Path) {
        if (OsProcess.isWindows) return
        runCatching {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"))
        }
    }

    private fun ok(provider: String): JsonObject = buildJsonObject {
        put("ok", true)
        put("provider", provider)
    }

    private fun error(message: String): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", message)
    }
}

/** JSON codec for the credential files: 2-space indent like pi writes it. */
private object PiManageJson {
    private val json = kotlinx.serialization.json.Json {
        ignoreUnknownKeys = true
        prettyPrint = true
        prettyPrintIndent = "  "
    }

    fun parse(text: String): JsonObject =
        json.parseToJsonElement(text) as? JsonObject
            ?: throw IllegalStateException("not a JSON object")

    fun text(obj: JsonObject): String = json.encodeToString(JsonObject.serializer(), obj)
}
