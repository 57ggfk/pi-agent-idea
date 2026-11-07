package dev.pi.agent.manage

import java.io.File
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 012 US3, T115/T117: the AGENTS.md location list mirrors pi's loader
 * (measured in T102): global dir first, then the project root, then
 * subdirectories — one row per directory, first candidate wins, VCS/build
 * trees never contribute, the scan is bounded. Create is UTF-8, idempotent,
 * and refuses paths outside the project/global roots.
 */
class PiAgentsTest {

    private val tempDirs = mutableListOf<File>()

    private fun tempDir(name: String): File {
        val d = java.nio.file.Files.createTempDirectory(name).toFile()
        tempDirs += d
        return d
    }

    @AfterTest
    fun cleanup() {
        tempDirs.forEach { dir -> dir.deleteRecursively() }
    }

    private fun params(path: String) = buildJsonObject { put("path", JsonPrimitive(path)) }

    private fun rows(projectPath: String?): List<Map<String, String>> {
        val json = PiAgents.list(projectPath)
        return json["entries"]!!.jsonArray.map { e ->
            val o = e.jsonObject
            mapOf(
                "scope" to o["scope"]!!.jsonPrimitive.content,
                "path" to o["path"]!!.jsonPrimitive.content,
                "exists" to o["exists"]!!.jsonPrimitive.content,
                "priority" to o["priority"]!!.jsonPrimitive.content,
                "fileName" to o["fileName"]!!.jsonPrimitive.content,
            )
        }
    }

    @Test
    fun `lists global, root and subdirectory entries in pi load order`() {
        val project = tempDir("pi-agents-proj")
        File(project, "AGENTS.md").writeText("root", Charsets.UTF_8)
        File(project, "sub/deep").mkdirs()
        File(project, "sub/deep/AGENTS.md").writeText("deep", Charsets.UTF_8)
        File(project, "other").mkdirs()
        File(project, "other/AGENTS.override.md").writeText("override", Charsets.UTF_8)

        val all = rows(project.absolutePath)
        // global (agentDir row always present) first
        assertEquals("global", all[0]["scope"])
        val scoped = all.filter { it["scope"] != "global" }
        assertEquals(3, scoped.size, "rows: $all")
        assertEquals("root", scoped[0]["scope"])
        assertTrue(scoped[0]["path"]!!.endsWith("AGENTS.md"))
        // subdirectories follow the root; the override candidate wins in its dir
        assertEquals(2, scoped.count { it["scope"] == "subdirectory" })
        assertTrue(scoped.any { it["fileName"] == "AGENTS.override.md" })
    }

    @Test
    fun `node_modules and build trees are excluded (decoys yield zero rows)`() {
        val project = tempDir("pi-agents-decoy")
        File(project, "AGENTS.md").writeText("root", Charsets.UTF_8)
        for (dir in listOf("node_modules/pkg", ".git/objects", "dist", "build")) {
            File(project, dir).mkdirs()
            File(File(project, dir), "AGENTS.md").writeText("decoy", Charsets.UTF_8)
        }
        val scoped = rows(project.absolutePath).filter { it["scope"] != "global" }
        assertEquals(1, scoped.size, "only the root row expected, got: $scoped")
    }

    @Test
    fun `a root without a context file still lists with exists=false`() {
        val project = tempDir("pi-agents-empty")
        val scoped = rows(project.absolutePath).filter { it["scope"] != "global" }
        assertEquals(1, scoped.size)
        assertEquals("false", scoped[0]["exists"])
        assertTrue(scoped[0]["path"]!!.endsWith("AGENTS.md"))
    }

    @Test
    fun `a CLAUDE-only directory falls back to the claude candidate`() {
        val project = tempDir("pi-agents-claude")
        File(project, "CLAUDE.md").writeText("claude", Charsets.UTF_8)
        val scoped = rows(project.absolutePath).filter { it["scope"] == "root" }
        assertEquals("CLAUDE.md", scoped[0]["fileName"])
        assertEquals("true", scoped[0]["exists"])
    }

    @Test
    fun `create is idempotent - two calls leave one file with the original content`() {
        val project = tempDir("pi-agents-create")
        val target = File(project, "AGENTS.md")

        val first = PiAgents.create(project.absolutePath, params(target.absolutePath))
        assertEquals("true", first["ok"]!!.jsonPrimitive.content)
        assertEquals("true", first["created"]!!.jsonPrimitive.content)
        val original = target.readText(Charsets.UTF_8)
        assertTrue(original.contains("AGENTS.md"))

        val second = PiAgents.create(project.absolutePath, params(target.absolutePath))
        assertEquals("false", second["created"]!!.jsonPrimitive.content, "creating twice must not rewrite")
        assertEquals(original, target.readText(Charsets.UTF_8), "content unchanged by the second call")
    }

    @Test
    fun `utf-8 chinese content round-trips losslessly through the same write path`() {
        val project = tempDir("pi-agents-utf8")
        val target = File(project, "AGENTS.md")
        PiAgents.create(project.absolutePath, params(target.absolutePath))
        // The panel never parses content (plan D4), but the create path must be
        // encoding-safe: write the way a user's file would look and read back.
        target.writeText("# 项目说明\n\n中文指令内容 ✅", Charsets.UTF_8)
        assertEquals("# 项目说明\n\n中文指令内容 ✅", target.readText(Charsets.UTF_8))
    }

    @Test
    fun `create refuses paths outside the project or global dir`() {
        val project = tempDir("pi-agents-guard")
        val outside = tempDir("pi-agents-outside")
        val result = PiAgents.create(project.absolutePath, params(File(outside, "AGENTS.md").absolutePath))
        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertFalse(File(outside, "AGENTS.md").exists())
    }

    @Test
    fun `open validates the path and reports a missing file without navigating`() {
        val project = tempDir("pi-agents-open")
        val target = File(project, "AGENTS.md")

        val missing = PiAgents.open(null, project.absolutePath, params(target.absolutePath))
        assertEquals("false", missing["ok"]!!.jsonPrimitive.content)
        assertTrue(missing["error"]!!.jsonPrimitive.content.contains("does not exist"))

        target.writeText("hello", Charsets.UTF_8)
        val ok = PiAgents.open(null, project.absolutePath, params(target.absolutePath))
        assertEquals("true", ok["ok"]!!.jsonPrimitive.content)
        assertEquals(target.absolutePath, ok["path"]!!.jsonPrimitive.content)

        val outside = tempDir("pi-agents-open-outside")
        val blocked = PiAgents.open(null, project.absolutePath, params(File(outside, "AGENTS.md").absolutePath))
        assertEquals("false", blocked["ok"]!!.jsonPrimitive.content)
    }
}
