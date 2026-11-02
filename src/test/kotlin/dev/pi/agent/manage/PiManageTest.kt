package dev.pi.agent.manage

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Project-level skills used to be scanned through `File(".pi/skills")`, i.e.
 * relative to the IDE process working directory. Two project windows would
 * therefore see the same (wrong) directory. These tests pin the basePath.
 */
class PiManageTest {

    private val tempDirs = mutableListOf<File>()

    private fun tempDir(): File =
        Files.createTempDirectory("pi-manage-test").toFile().also { tempDirs += it }

    @AfterTest
    fun cleanup() {
        tempDirs.forEach { runCatching { it.deleteRecursively() } }
    }

    private fun writeSkill(project: File, dir: String, name: String) {
        val skillDir = File(project, "$dir/$name")
        skillDir.mkdirs()
        File(skillDir, "SKILL.md").writeText("---\nname: $name\ndescription: $name skill\n---\n")
    }

    private fun skills(result: JsonObject): List<JsonObject> =
        result["skills"]!!.jsonArray.map { it.jsonObject }

    private fun JsonObject.text(key: String): String = this[key]!!.jsonPrimitive.content

    @Test
    fun `each project lists only its own project-level skills`() {
        val projectA = tempDir()
        val projectB = tempDir()
        writeSkill(projectA, ".pi/skills", "alpha")
        writeSkill(projectB, ".pi/skills", "beta")

        val a = skills(PiManage.skillsList(projectA.absolutePath)).filter { it.text("scope") == "project" }
        val b = skills(PiManage.skillsList(projectB.absolutePath)).filter { it.text("scope") == "project" }

        assertEquals(listOf("alpha"), a.map { it.text("name") })
        assertEquals(listOf("beta"), b.map { it.text("name") })
        assertTrue(a.single().text("path").startsWith(projectA.canonicalPath.replace('\\', '/')) ||
            a.single().text("path").startsWith(projectA.absolutePath),
            "paths must be absolute and inside the project")
    }

    @Test
    fun `agents skills are scanned too and tagged project scope`() {
        val project = tempDir()
        writeSkill(project, ".agents/skills", "from-agents")

        val projectSkills = skills(PiManage.skillsList(project.absolutePath))
            .filter { it.text("scope") == "project" }

        assertEquals(listOf("from-agents"), projectSkills.map { it.text("name") })
    }

    @Test
    fun `same skill name in two project dirs stays two entries`() {
        val project = tempDir()
        writeSkill(project, ".pi/skills", "dup")
        writeSkill(project, ".agents/skills", "dup")

        val projectSkills = skills(PiManage.skillsList(project.absolutePath))
            .filter { it.text("scope") == "project" && it.text("name") == "dup" }

        // Dedupe keys on the resolved SKILL.md: two distinct files are two
        // distinct skills even when they share a name.
        assertEquals(2, projectSkills.size)
        assertEquals(2, projectSkills.map { it.text("path") }.distinct().size)
    }

    @Test
    fun `no base path yields no project-level skills`() {
        val project = tempDir()
        writeSkill(project, ".pi/skills", "hidden")

        val all = skills(PiManage.skillsList(null))
        assertTrue(all.none { it.text("scope") == "project" })
        val blank = skills(PiManage.skillsList("   "))
        assertTrue(blank.none { it.text("scope") == "project" })
    }

    @Test
    fun `entries always carry a scope`() {
        val project = tempDir()
        writeSkill(project, ".pi/skills", "scoped")
        val all = skills(PiManage.skillsList(project.absolutePath))
        assertTrue(all.isNotEmpty())
        assertTrue(all.all { it["scope"] != null }, "every entry must declare user vs project scope")
    }
}
