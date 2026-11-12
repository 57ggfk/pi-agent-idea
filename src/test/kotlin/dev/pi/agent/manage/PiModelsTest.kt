package dev.pi.agent.manage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonObject
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** 027 T901: the models.json writer — merge safety, refusals, level maps. */
class PiModelsTest {

    private val agentDir = Files.createTempDirectory("pi-models-test").toFile()

    @AfterTest
    fun tearDown() {
        agentDir.deleteRecursively()
    }

    private val file: File get() = File(agentDir, "models.json")

    private fun save(name: String, overwrite: Boolean = false, models: String = """[{"id":"m1"}]"""): kotlinx.serialization.json.JsonObject {
        val form = Json.parseToJsonElement(
            """{"name":"$name","api":"openai-completions","baseUrl":"https://relay.example.com","apiKey":"sk-secret-123","models":$models}""",
        ).jsonObject
        return PiModels.providerSave(
            Json.parseToJsonElement("""{"overwrite":$overwrite}""").jsonObject.let {
                kotlinx.serialization.json.buildJsonObject {
                    it.forEach { (k, v) -> put(k, v) }
                    put("provider", form)
                }
            },
            agentDir = agentDir,
        )
    }

    @Test
    fun `thinking level map - three real levels and four nulls`() {
        val map = PiModels.buildThinkingLevelMap(listOf("low", "medium", "high"))!!
        assertEquals("low", (map["low"] as JsonPrimitive).content)
        assertEquals("high", (map["high"] as JsonPrimitive).content)
        assertEquals(JsonPrimitive(null), map["off"])
        assertEquals(JsonPrimitive(null), map["minimal"])
        assertEquals(JsonPrimitive(null), map["xhigh"])
        assertEquals(JsonPrimitive(null), map["max"])
    }

    @Test
    fun `thinking level map - off only or empty means no map at all`() {
        assertNull(PiModels.buildThinkingLevelMap(listOf("off")))
        assertNull(PiModels.buildThinkingLevelMap(emptyList()))
        assertNull(PiModels.buildThinkingLevelMap(listOf("bogus")))
        // All seven: every level maps to itself.
        val all = PiModels.buildThinkingLevelMap(PiModels.THINKING_LEVELS)!!
        PiModels.THINKING_LEVELS.forEach { assertEquals(it, (all[it] as JsonPrimitive).content) }
    }

    @Test
    fun `save creates the full shape and a backup on the next write`() {
        assertTrue(file.parentFile.mkdirs() || file.parentFile.isDirectory)
        val res = save("relay")
        assertEquals(true, res["ok"]?.let { it as JsonPrimitive }.let { it?.booleanOrNull == true })

        val root = Json.parseToJsonElement(file.readText()).jsonObject
        val p = root["providers"]!!.jsonObject["relay"]!!.jsonObject
        assertEquals("openai-completions", (p["api"] as JsonPrimitive).content)
        assertEquals("https://relay.example.com", (p["baseUrl"] as JsonPrimitive).content)
        assertEquals("sk-secret-123", (p["apiKey"] as JsonPrimitive).content)
        val model = (p["models"] as kotlinx.serialization.json.JsonArray)[0].jsonObject
        assertEquals("m1", (model["id"] as JsonPrimitive).content)
        // No thinking fields: the level list was empty → reasoning:false, no map.
        assertEquals(false, (model["reasoning"] as JsonPrimitive).booleanOrNull)
        assertNull(model["thinkingLevelMap"])
        assertEquals(listOf("text"), (model["input"] as kotlinx.serialization.json.JsonArray).map { (it as JsonPrimitive).content })

        // Second write leaves a timestamped backup behind.
        save("relay", overwrite = true)
        assertTrue(file.parentFile!!.listFiles()!!.any { it.name.startsWith("models.json.bak-") })
    }

    @Test
    fun `save refuses builtin and existing names without overwrite - file untouched`() {
        file.writeText("""{"providers":{"existing":{"baseUrl":"https://x"}}}""")
        val stampBefore = file.lastModified()
        val textBefore = file.readText()

        val builtin = save("openai")
        assertEquals(false, (builtin["ok"] as JsonPrimitive).booleanOrNull)
        assertEquals("builtin", (builtin["code"] as JsonPrimitive).content)

        val exists = save("existing")
        assertEquals("exists", (exists["code"] as JsonPrimitive).content)

        assertEquals(textBefore, file.readText())
        assertEquals(stampBefore, file.lastModified())
    }

    @Test
    fun `save keeps unknown fields of untouched providers and retained models`() {
        file.writeText(
            """{"providers":{
                "kept":{"baseUrl":"https://kept","compat":{"thinkingFormat":"deepseek"},"cost":{"in":1},"models":[{"id":"k1","headers":{"x":"y"}}]},
                "other":{"baseUrl":"https://other","customStuff":{"a":1}}
            },"topLevelUnknown":true}""",
        )
        val form = Json.parseToJsonElement(
            """{"name":"newp","api":"anthropic-messages","baseUrl":"https://n","apiKey":"sk-2","models":[{"id":"n1","thinkingLevels":["low","medium","high"],"inputImage":true}]}""",
        ).jsonObject
        val res = PiModels.providerSave(
            kotlinx.serialization.json.buildJsonObject { put("provider", form) },
            agentDir = agentDir,
        )
        assertEquals(true, (res["ok"] as JsonPrimitive).booleanOrNull)

        val root = Json.parseToJsonElement(file.readText()).jsonObject
        // Unknown top-level key survives.
        assertEquals(true, (root["topLevelUnknown"] as JsonPrimitive).booleanOrNull)
        val providers = root["providers"]!!.jsonObject
        // Untouched provider: byte-for-byte identical semantics (pretty-printed
        // rewrite, so compare the JSON value).
        val other = providers["other"]!!.jsonObject
        assertEquals("https://other", (other["baseUrl"] as JsonPrimitive).content)
        assertNotNull(other["customStuff"])
        // Retained provider: unknown provider-level AND model-level keys survive.
        val kept = providers["kept"]!!.jsonObject
        assertEquals("deepseek", ((kept["compat"]!!.jsonObject)["thinkingFormat"])?.let { it as JsonPrimitive }?.content)
        val keptModel = (kept["models"] as kotlinx.serialization.json.JsonArray)[0].jsonObject
        assertEquals("y", ((keptModel["headers"]!!.jsonObject)["x"])?.let { it as JsonPrimitive }?.content)
        // The new provider's model carries the level map + image input.
        val newModel = (providers["newp"]!!.jsonObject["models"] as kotlinx.serialization.json.JsonArray)[0].jsonObject
        assertEquals(true, (newModel["reasoning"] as JsonPrimitive).booleanOrNull)
        assertEquals("low", ((newModel["thinkingLevelMap"]!!.jsonObject)["low"])?.let { it as JsonPrimitive }?.content)
        assertEquals(
            listOf("text", "image"),
            (newModel["input"] as kotlinx.serialization.json.JsonArray).map { (it as JsonPrimitive).content },
        )
    }

    @Test
    fun `edit with a blank key keeps the stored one`() {
        save("relay", overwrite = true)
        val keyBefore = Json.parseToJsonElement(file.readText()).jsonObject["providers"]!!
            .jsonObject["relay"]!!.jsonObject["apiKey"]

        val form = Json.parseToJsonElement(
            """{"name":"relay","api":"openai-completions","baseUrl":"https://relay.example.com/v2","apiKey":"","models":[{"id":"m1"}]}""",
        ).jsonObject
        val res = PiModels.providerSave(
            kotlinx.serialization.json.buildJsonObject { put("provider", form); put("overwrite", true) },
            agentDir = agentDir,
        )
        assertEquals(true, (res["ok"] as JsonPrimitive).booleanOrNull)
        val keyAfter = Json.parseToJsonElement(file.readText()).jsonObject["providers"]!!
            .jsonObject["relay"]!!.jsonObject["apiKey"]
        assertEquals(keyBefore, keyAfter)
        val baseUrl = Json.parseToJsonElement(file.readText()).jsonObject["providers"]!!
            .jsonObject["relay"]!!.jsonObject["baseUrl"]
        assertNotEquals("https://relay.example.com", (baseUrl as JsonPrimitive).content)
    }

    @Test
    fun `delete removes the entry and refuses builtins`() {
        save("relay", overwrite = true)
        val res = PiModels.providerDelete(Json.parseToJsonElement("""{"name":"relay"}""").jsonObject, agentDir = agentDir)
        assertEquals(true, (res["ok"] as JsonPrimitive).booleanOrNull)
        assertFalse(Json.parseToJsonElement(file.readText()).jsonObject["providers"]!!.jsonObject.containsKey("relay"))

        val builtin = PiModels.providerDelete(Json.parseToJsonElement("""{"name":"openai"}""").jsonObject, agentDir = agentDir)
        assertEquals("builtin", (builtin["code"] as JsonPrimitive).content)
    }

    @Test
    fun `providerGet masks the key and reports levels`() {
        val form = Json.parseToJsonElement(
            """{"name":"relay","api":"openai-completions","baseUrl":"https://relay","apiKey":"sk-abcd1234","models":[{"id":"m1","name":"Model One","thinkingLevels":["minimal","medium"],"inputImage":false}]}""",
        ).jsonObject
        PiModels.providerSave(kotlinx.serialization.json.buildJsonObject { put("provider", form) }, agentDir = agentDir)

        val res = PiModels.providerGet(Json.parseToJsonElement("""{"name":"relay"}""").jsonObject, agentDir = agentDir)
        assertEquals(true, (res["exists"] as JsonPrimitive).booleanOrNull)
        val text = res.toString()
        assertFalse(text.contains("sk-abcd1234"), "the raw key must never cross the bridge: $text")
        val p = res["provider"]!!.jsonObject
        assertEquals(true, (p["hasKey"] as JsonPrimitive).booleanOrNull)
        assertTrue((p["keyMasked"] as JsonPrimitive).content.contains("…"))
        val model = (p["models"] as kotlinx.serialization.json.JsonArray)[0].jsonObject
        assertEquals(
            listOf("minimal", "medium"),
            (model["thinkingLevels"] as kotlinx.serialization.json.JsonArray).map { (it as JsonPrimitive).content },
        )
        assertEquals(false, (model["inputImage"] as JsonPrimitive).booleanOrNull)
    }
}
