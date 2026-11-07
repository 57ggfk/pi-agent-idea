package dev.pi.agent.manage

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 012 US5/US6, T127: credential writes. The contract is narrow — auth.json
 * entries merge under a directory lock (pi's protocol), models.json gets an
 * atomic replace on an EXISTING provider, the response carries the provider
 * name only, and a corrupt target is an error, never overwritten.
 */
class PiCredentialsTest {

    private val tempDirs = mutableListOf<java.io.File>()

    private fun tempDir(name: String): java.io.File =
        java.nio.file.Files.createTempDirectory(name).toFile().also { tempDirs += it }

    @AfterTest
    fun cleanup() {
        tempDirs.forEach { it.deleteRecursively() }
    }

    private fun params(provider: String, key: String): JsonObject = buildJsonObject {
        put("provider", provider)
        put("key", key)
    }

    @Test
    fun `authSet merges into auth json and preserves other providers`() {
        val dir = tempDir("pi-cred-1")
        java.io.File(dir, "auth.json").writeText(
            """{"openrouter":{"type":"api_key","key":"existing"}}""",
        )

        val result = PiCredentials.authSet(params("custom-provider", "sk-secret-value"), dir)

        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        assertEquals("custom-provider", result["provider"]!!.jsonPrimitive.content)
        val text = java.io.File(dir, "auth.json").readText()
        assertTrue(text.contains("\"openrouter\""), "existing entry preserved")
        assertTrue(text.contains("\"custom-provider\""), "new entry present")
        // the file parses again and the schema shape is pi's
        val obj = kotlinx.serialization.json.Json.parseToJsonElement(text).jsonObject
        assertEquals("api_key", obj["custom-provider"]!!.jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun `authSet creates the file when absent and responds without the key`() {
        val dir = tempDir("pi-cred-2")
        val result = PiCredentials.authSet(params("openrouter", "sk-abc"), dir)
        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        val responseText = result.toString()
        assertTrue("sk-abc" !in responseText, "the key never crosses the bridge")
        assertTrue(!java.io.File(dir, "auth.json.lock").exists(), "lock released")
    }

    @Test
    fun `authSet refuses a corrupt auth json instead of overwriting it`() {
        val dir = tempDir("pi-cred-3")
        java.io.File(dir, "auth.json").writeText("{not json")
        val result = PiCredentials.authSet(params("p", "k"), dir)
        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertEquals("{not json", java.io.File(dir, "auth.json").readText(), "corrupt file untouched")
    }

    @Test
    fun `authDelete removes only the named entry`() {
        val dir = tempDir("pi-cred-4")
        java.io.File(dir, "auth.json").writeText(
            """{"a":{"type":"api_key","key":"1"},"b":{"type":"api_key","key":"2"}}""",
        )
        val result = PiCredentials.authDelete(buildJsonObject { put("provider", "a") }, dir)
        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        val obj = kotlinx.serialization.json.Json.parseToJsonElement(java.io.File(dir, "auth.json").readText()).jsonObject
        assertEquals(setOf("b"), obj.keys)
    }

    @Test
    fun `stale locks older than the window are broken`() {
        val dir = tempDir("pi-cred-5")
        val lock = java.io.File(dir, "auth.json.lock")
        lock.mkdirs()
        // simulate a lock left behind long ago
        lock.setLastModified(System.currentTimeMillis() - 60_000)
        val result = PiCredentials.authSet(params("p", "k"), dir)
        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        assertTrue(!lock.exists(), "lock released after the write")
    }

    @Test
    fun `providerSetKey writes the key into an existing models json provider`() {
        val dir = tempDir("pi-cred-6")
        java.io.File(dir, "models.json").writeText(
            """
            {
              "providers": {
                "xiami": { "baseUrl": "https://x.example.com/v1", "api": "openai-completions" }
              }
            }
            """.trimIndent(),
        )
        val result = PiCredentials.providerSetKey(params("xiami", "tp-token"), dir)
        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        val obj = kotlinx.serialization.json.Json.parseToJsonElement(java.io.File(dir, "models.json").readText()).jsonObject
        val entry = obj["providers"]!!.jsonObject["xiami"]!!.jsonObject
        assertEquals("tp-token", entry["apiKey"]!!.jsonPrimitive.content)
        assertEquals("https://x.example.com/v1", entry["baseUrl"]!!.jsonPrimitive.content, "other fields kept")
    }

    @Test
    fun `providerSetKey refuses an unknown provider instead of inventing one`() {
        val dir = tempDir("pi-cred-7")
        java.io.File(dir, "models.json").writeText("""{"providers":{}}""")
        val result = PiCredentials.providerSetKey(params("ghost", "k"), dir)
        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertTrue(result["error"]!!.jsonPrimitive.content.contains("no provider named"))
    }

    @Test
    fun `both writers reject invalid provider names and oversized keys`() {
        val dir = tempDir("pi-cred-8")
        assertEquals("false", PiCredentials.authSet(params("bad name!", "k"), dir)["ok"]!!.jsonPrimitive.content)
        assertEquals("false", PiCredentials.authSet(params("p", "x".repeat(5000)), dir)["ok"]!!.jsonPrimitive.content)
        assertEquals("false", PiCredentials.providerSetKey(params("", "k"), dir)["ok"]!!.jsonPrimitive.content)
    }

    @Test
    fun `responses never contain the key material`() {
        val dir = tempDir("pi-cred-9")
        val results = listOf(
            PiCredentials.authSet(params("p1", "SK-VERY-SECRET"), dir),
            PiCredentials.providerSetKey(params("p1", "SK-VERY-SECRET"), dir),
            PiCredentials.authSet(params("p1", "x".repeat(5000)), dir),
        )
        for (r in results) {
            assertTrue("SK-VERY-SECRET" !in r.toString(), "leak in $r")
        }
        // logs: nothing was printed; assert the auth.json write happened with
        // the key present on disk (that is its home) and nowhere in memory
        // representations we return.
        assertTrue(java.io.File(dir, "auth.json").readText().contains("SK-VERY-SECRET"))
    }
}
