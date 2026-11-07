package dev.pi.agent.manage

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.put
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Spec 001 US4: provider details are read-only with a reverse whitelist —
 * unknown keys pass through, secret values never do. The T019 hard assertion
 * (the raw secret must not appear anywhere in the returned JSON) lives here.
 */
class PiManageProviderTest {

    private val tempDirs = mutableListOf<File>()

    private fun tempDir(): File =
        Files.createTempDirectory("pi-provider-test").toFile().also { tempDirs += it }

    @AfterTest
    fun cleanup() {
        tempDirs.forEach { runCatching { it.deleteRecursively() } }
    }

    private fun params(vararg pairs: Pair<String, String>): JsonObject = buildJsonObject {
        pairs.forEach { (k, v) -> put(k, v) }
    }

    private fun writeModels(dir: File, text: String) {
        File(dir, "models.json").writeText(text)
    }

    private fun read(params: JsonObject, dir: File = tempDir()): JsonObject =
        PiManage.modelsReadProvider(params, agentDir = dir)

    // -- T019: sanitisation ----------------------------------------------------

    @Test
    fun `apiKey value never appears in the returned JSON`() {
        val dir = tempDir()
        writeModels(
            dir,
            """
            {
              "providers": {
                "acme": {
                  "type": "openai_completions",
                  "baseUrl": "https://api.acme.dev/v1",
                  "apiKey": "sk-super-secret-abc123",
                  "headers": { "Authorization": "Bearer bearer-secret-42" },
                  "models": [ { "id": "acme-large", "contextWindow": 128000 } ]
                }
              }
            }
            """.trimIndent(),
        )

        val result = read(params("name" to "acme"), dir)
        assertEquals(true, result["ok"]!!.jsonPrimitive.boolean)

        val config = result["config"]!!.jsonObject
        // Sensitive keys become booleans, keeping their key names.
        assertEquals(true, config["apiKey"]!!.jsonPrimitive.boolean)
        assertEquals(true, config["headers"]!!.jsonObject["Authorization"]!!.jsonPrimitive.boolean)
        // Non-sensitive fields survive the reverse whitelist untouched.
        assertEquals("openai_completions", config["type"]!!.jsonPrimitive.content)
        assertEquals("https://api.acme.dev/v1", config["baseUrl"]!!.jsonPrimitive.content)
        // models is an array; the id must still be present as-is.
        assertTrue(config.toString().contains("acme-large"))

        // The hard assertion (T019 / constitution VI): the raw secret must not
        // exist anywhere in the payload, including nested structures.
        val flat = result.toString()
        assertFalse(flat.contains("sk-super-secret-abc123"), "apiKey value leaked: $flat")
        assertFalse(flat.contains("bearer-secret-42"), "Authorization value leaked: $flat")
    }

    @Test
    fun `an empty sensitive value reads as not configured`() {
        val dir = tempDir()
        writeModels(
            dir,
            """
            {
              "providers": {
                "acme": { "apiKey": "", "type": "openai_completions" }
              }
            }
            """.trimIndent(),
        )

        val config = read(params("name" to "acme"), dir)["config"]!!.jsonObject
        assertEquals(false, config["apiKey"]!!.jsonPrimitive.boolean)
        assertEquals("openai_completions", config["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun `unknown keys pass through so a schema change cannot hide config`() {
        val dir = tempDir()
        writeModels(
            dir,
            """
            {
              "providers": {
                "acme": { "someFutureKey": { "nested": [1, 2] }, "clientSecret": "hush" }
              }
            }
            """.trimIndent(),
        )

        val config = read(params("name" to "acme"), dir)["config"]!!.jsonObject
        assertEquals("""{"nested":[1,2]}""", config["someFutureKey"].toString().replace(" ", ""))
        assertEquals(true, config["clientSecret"]!!.jsonPrimitive.boolean)
    }

    // -- FR-013: missing / corrupt / absent ------------------------------------

    @Test
    fun `a missing models file is reported as missing, not as an empty panel`() {
        val result = read(params("name" to "acme"))
        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertEquals("true", result["missing"]!!.jsonPrimitive.content)
        assertTrue(result["error"]!!.jsonPrimitive.content.contains("not found"))
    }

    @Test
    fun `a corrupt models file reports the parse failure with a position`() {
        val dir = tempDir()
        writeModels(dir, "{\n  \"providers\": {\n")

        val result = read(params("name" to "acme"), dir)
        val error = result["error"]!!.jsonPrimitive.content
        assertTrue(error.contains("not valid JSON"), "got: $error")
        assertTrue(Regex("line \\d+, column \\d+").containsMatchIn(error), "position missing: $error")
    }

    @Test
    fun `an unknown provider name is a structured error`() {
        val dir = tempDir()
        writeModels(dir, """{ "providers": { "acme": { "type": "openai_completions" } } }""")

        val result = read(params("name" to "nope"), dir)
        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertTrue(result["error"]!!.jsonPrimitive.content.contains("no provider named"))
    }

    @Test
    fun `a models file without a providers object is rejected`() {
        val dir = tempDir()
        writeModels(dir, """{ "somethingElse": {} }""")

        val result = read(params("name" to "acme"), dir)
        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertTrue(result["error"]!!.jsonPrimitive.content.contains("providers"))
    }

    // -- T020: skeleton + navigation --------------------------------------------

    @Test
    fun `ensureFile creates a valid skeleton only when absent`() {
        val dir = tempDir()

        val created = PiManage.modelsEnsureFile(agentDir = dir)
        assertTrue(created.created)
        val parsed = kotlinx.serialization.json.Json.parseToJsonElement(created.file.readText()).jsonObject
        assertTrue(parsed.containsKey("providers"))

        // An existing file is never touched — "open in editor" must not be able
        // to reset a configuration that merely failed to parse.
        created.file.writeText("""{ "providers": { "keep": {} } }""")
        val second = PiManage.modelsEnsureFile(agentDir = dir)
        assertFalse(second.created)
        assertTrue(second.file.readText().contains("\"keep\""))
    }

    @Test
    fun `provider line navigation finds the provider segment`() {
        val dir = tempDir()
        val file = File(dir, "models.json").apply {
            writeText("{\n  \"providers\": {\n    \"acme\": {\n      \"type\": \"openai_completions\"\n    }\n  }\n}")
        }
        assertEquals(3, PiManage.modelsProviderLine(file, "acme"))
        assertEquals(1, PiManage.modelsProviderLine(file, "nope"))
        assertEquals(1, PiManage.modelsProviderLine(file, null))
    }

    // -- authOverview modelsState (FR-013 on the panel level) -------------------

    @Test
    fun `authOverview reports the three models json states`() {
        val missingDir = tempDir()
        val missing = PiManage.authOverview(agentDir = missingDir).jsonObject
        assertEquals("missing", missing["modelsState"]!!.jsonPrimitive.content)

        val corruptDir = tempDir()
        File(corruptDir, "models.json").writeText("{ broken")
        val corrupt = PiManage.authOverview(agentDir = corruptDir).jsonObject
        assertEquals("corrupt", corrupt["modelsState"]!!.jsonPrimitive.content)
        assertTrue(corrupt["modelsError"]!!.jsonPrimitive.content.contains("not valid JSON"))

        val okDir = tempDir()
        File(okDir, "auth.json").writeText("""{ "anthropic": { "apiKey": "x" } }""")
        File(okDir, "models.json").writeText("""{ "providers": { "acme": {} } }""")
        val ok = PiManage.authOverview(agentDir = okDir).jsonObject
        assertEquals("ok", ok["modelsState"]!!.jsonPrimitive.content)
        val providers = ok["providers"].toString()
        assertTrue(providers.contains("anthropic") && providers.contains("acme"))
    }

    @Test
    fun `authOverview maps stored credential types and skips unknown ones`() {
        val dir = tempDir()
        File(dir, "auth.json").writeText(
            """{ "anthropic": { "type": "oauth", "access": "a", "refresh": "r", "expires": 1 },
               |  "deepseek": { "type": "api_key", "key": "k" },
               |  "weird": { "type": "emoji" },
               |  "shapeless": "not-an-object" }""".trimMargin(),
        )
        val overview = PiManage.authOverview(agentDir = dir).jsonObject
        val types = overview["credentialTypes"]!!.jsonObject
        assertEquals("oauth", types["anthropic"]!!.jsonPrimitive.content)
        assertEquals("api_key", types["deepseek"]!!.jsonPrimitive.content)
        assertFalse(types.containsKey("weird"))
        assertFalse(types.containsKey("shapeless"))
        // withCredentials still lists every entry regardless of type
        val creds = overview["withCredentials"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("anthropic", "deepseek", "shapeless", "weird"), creds)
    }

    @Test
    fun `authOverview tolerates a missing or corrupt auth json`() {
        val missingDir = tempDir()
        val missing = PiManage.authOverview(agentDir = missingDir).jsonObject
        assertTrue(missing["credentialTypes"]!!.jsonObject.isEmpty())

        val corruptDir = tempDir()
        File(corruptDir, "auth.json").writeText("{ broken")
        val corrupt = PiManage.authOverview(agentDir = corruptDir).jsonObject
        assertTrue(corrupt["credentialTypes"]!!.jsonObject.isEmpty())
    }
}
