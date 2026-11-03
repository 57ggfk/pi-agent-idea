package dev.pi.agent.manage

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Disabling an MCP server is a config edit, not a removal (pi honours
 * `enabled: false`). These tests pin the two things that make that safe:
 * the rest of the entry survives byte-for-byte, and a write that would be
 * ignored by pi is refused or flagged instead of reported as done.
 */
class PiMcpConfigTest {

    private val tempDirs = mutableListOf<File>()

    private fun tempDir(): File =
        Files.createTempDirectory("pi-mcp-config-test").toFile().also { tempDirs += it }

    @AfterTest
    fun cleanup() {
        tempDirs.forEach { runCatching { it.deleteRecursively() } }
    }

    private fun writeMcp(dir: File, text: String): File =
        File(dir, "mcp.json").apply { writeText(text.trimIndent()) }

    private fun trusted(agentDir: File, project: File) {
        File(agentDir, "trust.json").writeText(
            buildJsonObject { put(project.canonicalPath, JsonPrimitive(true)) }.toString(),
        )
    }

    private fun entry(file: File, name: String): JsonObject {
        val root = JsonObject.serializer().let {
            kotlinx.serialization.json.Json.parseToJsonElement(file.readText()) as JsonObject
        }
        return root["mcpServers"]!!.jsonObject[name]!!.jsonObject
    }

    private val oneServer = """
        {
          "mcpServers": {
            "github": {
              "command": "npx",
              "args": ["-y", "@modelcontextprotocol/server-github"],
              "env": { "GITHUB_TOKEN": "ghp_value" },
              "description": "Issues and PRs"
            }
          }
        }
    """

    // -- disable / enable ----------------------------------------------------

    @Test
    fun `disabling keeps every other field of the entry`() {
        val agent = tempDir()
        val file = writeMcp(agent, oneServer)

        val outcome = PiMcpConfig.setEnabled("github", PiMcpConfig.SCOPE_GLOBAL, false, null, agent)

        assertTrue(outcome.ok, outcome.error)
        assertEquals(false, outcome.enabled)
        val entry = entry(file, "github")
        assertEquals(false, entry["enabled"]!!.jsonPrimitive.boolean)
        // The whole point of the feature: nothing else moved.
        assertEquals("npx", entry["command"]!!.jsonPrimitive.content)
        assertEquals(
            listOf("-y", "@modelcontextprotocol/server-github"),
            entry["args"]!!.jsonArray.map { it.jsonPrimitive.content },
        )
        assertEquals("ghp_value", entry["env"]!!.jsonObject["GITHUB_TOKEN"]!!.jsonPrimitive.content)
        assertEquals("Issues and PRs", entry["description"]!!.jsonPrimitive.content)
    }

    @Test
    fun `re-enabling removes the field instead of writing true`() {
        val agent = tempDir()
        val file = writeMcp(agent, oneServer)
        PiMcpConfig.setEnabled("github", PiMcpConfig.SCOPE_GLOBAL, false, null, agent)

        val outcome = PiMcpConfig.setEnabled("github", PiMcpConfig.SCOPE_GLOBAL, true, null, agent)

        assertTrue(outcome.ok, outcome.error)
        // `enabled` is optional and defaults to true, so a missing key is the
        // clean representation — and keeps a later disable a one-key diff.
        assertFalse(entry(file, "github").containsKey("enabled"))
        assertEquals("npx", entry(file, "github")["command"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a request that changes nothing does not rewrite the file`() {
        val agent = tempDir()
        val file = writeMcp(agent, oneServer)
        val before = file.readText()

        val outcome = PiMcpConfig.setEnabled("github", PiMcpConfig.SCOPE_GLOBAL, true, null, agent)

        assertTrue(outcome.ok, outcome.error)
        assertEquals(before, file.readText())
        // No backup either: nothing was written.
        assertFalse(File(agent, "mcp.json.bak").exists())
    }

    @Test
    fun `the backup holds the pre-edit content`() {
        val agent = tempDir()
        val file = writeMcp(agent, oneServer)
        val before = file.readText()

        PiMcpConfig.setEnabled("github", PiMcpConfig.SCOPE_GLOBAL, false, null, agent)

        val backup = File(agent, "mcp.json.bak")
        assertTrue(backup.isFile)
        assertEquals(before, backup.readText())
    }

    @Test
    fun `unrelated top level keys and entry order survive the edit`() {
        val agent = tempDir()
        val file = writeMcp(
            agent,
            """
            {
              "version": 3,
              "mcpServers": {
                "alpha": { "command": "a" },
                "beta": { "command": "b" }
              }
            }
            """,
        )

        PiMcpConfig.setEnabled("alpha", PiMcpConfig.SCOPE_GLOBAL, false, null, agent)

        val root = kotlinx.serialization.json.Json.parseToJsonElement(file.readText()) as JsonObject
        assertEquals(3, root["version"]!!.jsonPrimitive.content.toInt())
        // Insertion order is preserved, so `pi mcp add` diffs stay minimal.
        assertEquals(listOf("alpha", "beta"), root["mcpServers"]!!.jsonObject.keys.toList())
        assertFalse(root["mcpServers"]!!.jsonObject["beta"]!!.jsonObject.containsKey("enabled"))
    }

    // -- refusals ------------------------------------------------------------

    @Test
    fun `an unknown server is a structured error`() {
        val agent = tempDir()
        writeMcp(agent, oneServer)

        val outcome = PiMcpConfig.setEnabled("nope", PiMcpConfig.SCOPE_GLOBAL, false, null, agent)

        assertFalse(outcome.ok)
        assertTrue(outcome.error!!.contains("no MCP server named"), outcome.error)
    }

    @Test
    fun `a missing file is an error, not a silent success`() {
        val agent = tempDir()

        val outcome = PiMcpConfig.setEnabled("github", PiMcpConfig.SCOPE_GLOBAL, false, null, agent)

        assertFalse(outcome.ok)
        assertTrue(outcome.error!!.contains("does not exist"), outcome.error)
    }

    @Test
    fun `malformed json is refused and left byte identical`() {
        val agent = tempDir()
        val file = writeMcp(agent, "{ \"mcpServers\": { oops }")
        val before = file.readText()

        val outcome = PiMcpConfig.setEnabled("github", PiMcpConfig.SCOPE_GLOBAL, false, null, agent)

        assertFalse(outcome.ok)
        assertTrue(outcome.error!!.contains("not valid JSON"), outcome.error)
        assertEquals(before, file.readText())
    }

    @Test
    fun `a project level change is refused while the project is untrusted`() {
        val agent = tempDir()
        val project = tempDir()
        File(project, ".pi").mkdirs()
        val file = File(project, ".pi/mcp.json").apply { writeText(oneServer.trimIndent()) }

        val outcome = PiMcpConfig.setEnabled("github", PiMcpConfig.SCOPE_PROJECT, false, project.path, agent)

        assertFalse(outcome.ok)
        // pi ignores the file entirely; writing it would look like it worked.
        assertTrue(outcome.error!!.contains("not trusted"), outcome.error)
        assertFalse(entry(file, "github").containsKey("enabled"))
    }

    // -- cross-layer truth ---------------------------------------------------

    @Test
    fun `a project override that still decides the value is reported`() {
        val agent = tempDir()
        val project = tempDir()
        trusted(agent, project)
        writeMcp(agent, oneServer)
        File(project, ".pi").mkdirs()
        File(project, ".pi/mcp.json").writeText(
            """
            { "mcpServers": { "github": { "enabled": true } } }
            """.trimIndent(),
        )

        // The project path is what makes the override check possible; the
        // bridge always injects it (BridgeService.withProjectPath).
        val outcome = PiMcpConfig.setEnabled("github", PiMcpConfig.SCOPE_GLOBAL, false, project.path, agent)
        assertTrue(outcome.ok, outcome.error)
        assertNotNull(outcome.warning)
        assertTrue(outcome.warning!!.contains("stays enabled"), outcome.warning)
    }

    @Test
    fun `no warning when the other layer agrees`() {
        val agent = tempDir()
        writeMcp(agent, oneServer)

        val outcome = PiMcpConfig.setEnabled("github", PiMcpConfig.SCOPE_GLOBAL, false, null, agent)

        assertNull(outcome.warning)
    }

    // -- reading -------------------------------------------------------------

    @Test
    fun `entries defaults a missing enabled field to true`() {
        val agent = tempDir()
        writeMcp(
            agent,
            """
            {
              "mcpServers": {
                "on": { "command": "a" },
                "off": { "command": "b", "enabled": false },
                "override": { "enabled": false }
              }
            }
            """,
        )

        val entries = PiMcpConfig.entries(PiMcpConfig.SCOPE_GLOBAL, null, agent).associateBy { it.name }

        assertEquals(true, entries["on"]!!.enabled)
        assertTrue(entries["on"]!!.definesServer)
        assertEquals(false, entries["off"]!!.enabled)
        // An entry with no command/url/type is an override, not a definition.
        assertFalse(entries["override"]!!.definesServer)
    }
}
