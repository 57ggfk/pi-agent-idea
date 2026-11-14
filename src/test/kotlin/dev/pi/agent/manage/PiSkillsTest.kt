package dev.pi.agent.manage

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Spec 034: six-source skill discovery, the settings-exclusion enable/disable
 * switch (probe-verified `-exact` / `!glob` semantics, bare names invalid),
 * external skill sources (the Claude/Codex bridge) and the frontmatter soft
 * switch. All fixtures live in temp dirs.
 */
class PiSkillsTest {

    private val tempDirs = mutableListOf<File>()

    private fun tempDir(): File =
        Files.createTempDirectory("pi-skills-test").toFile().also { tempDirs += it }

    @AfterTest
    fun cleanup() {
        tempDirs.forEach { runCatching { it.deleteRecursively() } }
    }

    private fun writeSkill(dir: File, name: String, description: String = "$name skill", extra: String = ""): File {
        val skillDir = File(dir, name)
        skillDir.mkdirs()
        File(skillDir, "SKILL.md").writeText("---\nname: $name\ndescription: $description\n$extra---\n")
        return skillDir
    }

    private fun agentDirWith(vararg skills: String): File {
        val agent = tempDir()
        skills.forEach { writeSkill(File(agent, "skills"), it) }
        return agent
    }

    private fun listing(agent: File, home: File = tempDir(), project: String? = null): PiSkills.Listing =
        PiSkills.list(agent, home, project)

    private fun names(listing: PiSkills.Listing, source: String? = null): List<String> =
        listing.entries.filter { source == null || it.source == source }.map { it.name }

    // -- six-source discovery (T1501) ------------------------------------------

    @Test
    fun `discovers user-pi and user-agents sources with attribution`() {
        val agent = agentDirWith("alpha")
        val home = tempDir()
        writeSkill(File(home, ".agents/skills"), "gamma")

        val listing = listing(agent, home)

        assertTrue(names(listing).containsAll(listOf("alpha", "gamma")))
        assertEquals("user-pi", listing.entries.single { it.name == "alpha" }.source)
        assertEquals("user-agents", listing.entries.single { it.name == "gamma" }.source)
        assertEquals("user", listing.entries.single { it.name == "gamma" }.scope)
    }

    @Test
    fun `project skills come from project-pi and every ancestor agents dir`() {
        val repo = tempDir()
        val nested = File(repo, "docs/deep").apply { mkdirs() }
        writeSkill(File(repo, ".pi/skills"), "root-pi")
        writeSkill(File(repo, ".agents/skills"), "root-agents")
        writeSkill(File(repo, "docs/.agents/skills"), "mid-agents")
        File(repo, ".git").mkdirs()

        // The IDE hands over the project base (= the pi working directory).
        // Only `.agents/skills` walks ancestors up to the repo root; `.pi/skills`
        // reads the base itself — so a subdirectory base sees the docs-level
        // agents dir, while a repo-root base sees only its own.
        val fromNested = listing(tempDir(), tempDir(), nested.absolutePath)
        assertTrue(
            names(fromNested, "project-agents") == listOf("mid-agents", "root-agents"),
            "nested base collects docs + repo agents dirs, got ${names(fromNested, "project-agents")}",
        )

        val fromRepo = listing(tempDir(), tempDir(), repo.absolutePath)
        assertTrue(names(fromRepo, "project-pi") == listOf("root-pi"))
        assertTrue(
            names(fromRepo, "project-agents") == listOf("root-agents"),
            "repo-root base stops at the repo root, got ${names(fromRepo, "project-agents")}",
        )
        assertTrue(
            listing(tempDir(), tempDir(), nested.absolutePath)
                .entries.filter { it.source.startsWith("project") }.all { it.scope == "project" },
        )
    }

    @Test
    fun `package skills resolve from the npm prefix and carry the package source`() {
        val agent = tempDir()
        val pkg = File(agent, "npm/node_modules/openwiki/integrations/openwiki")
        writeSkill(pkg.parentFile, "openwiki-skill")
        File(agent, "settings.json").writeText("""{"packages":["npm:openwiki"]}""")

        val listing = listing(agent, tempDir())

        assertEquals(listOf("openwiki-skill"), names(listing, "package"))
        assertEquals("user", listing.entries.single { it.source == "package" }.scope)
    }

    @Test
    fun `external dirs from settings are scanned and reported`() {
        val agent = agentDirWith("alpha")
        val external = tempDir()
        writeSkill(external, "claude-skill")
        val dir = external.absolutePath.replace('\\', '/')
        File(agent, "settings.json").writeText("""{"skills":["$dir"]}""")

        val listing = listing(agent, tempDir())

        assertEquals(listOf("claude-skill"), names(listing, "external"))
        assertEquals(listOf(dir), listing.externalSources)
    }

    @Test
    fun `duplicate names are flagged beyond the first discovery`() {
        val agent = agentDirWith("dup")
        val home = tempDir()
        writeSkill(File(home, ".agents/skills"), "dup")

        val listing = listing(agent, home)

        val dupes = listing.entries.filter { it.name == "dup" }
        assertEquals(2, dupes.size)
        assertEquals(listOf(false, true), dupes.map { it.duplicate })
    }

    // -- enable/disable via settings exclusions (FR-003) --------------------------

    @Test
    fun `an exact exclusion disables its skill`() {
        val agent = agentDirWith("alpha", "beta")
        val beta = File(agent, "skills/beta")
        File(agent, "settings.json").writeText(
            """{"skills":["-${beta.absolutePath.replace('\\', '/')}/SKILL.md"]}""",
        )

        val listing = listing(agent, tempDir())

        assertTrue(listing.entries.single { it.name == "alpha" }.enabled)
        assertFalse(listing.entries.single { it.name == "beta" }.enabled, "beta is excluded")
        assertTrue(listing.entries.single { it.name == "beta" }.path.isNotEmpty(), "excluded skills stay visible")
    }

    @Test
    fun `a glob exclusion disables matching skills`() {
        val agent = agentDirWith("beta")
        File(agent, "settings.json").writeText("""{"skills":["!**/beta/**"]}""")

        val listing = listing(agent, tempDir())

        assertFalse(listing.entries.single { it.name == "beta" }.enabled)
    }

    @Test
    fun `setEnabled round-trips the exclusion entry and preserves unknown keys`() {
        val agent = agentDirWith("alpha")
        val skillDir = File(agent, "skills/alpha")
        File(agent, "settings.json").writeText("""{"quietStartup":true,"packages":["npm:x"]}""")

        val off = PiSkills.setEnabled(skillDir.absolutePath, false, "user", agent, null)
        assertTrue(off["ok"]!!.jsonPrimitive.content.toBoolean())
        val saved = File(agent, "settings.json").readText()
        assertTrue(saved.contains("\"quietStartup\"") && saved.contains("\"packages\""), "unknown keys survive")
        assertTrue(saved.contains("-"), "the exclusion entry landed")

        val on = PiSkills.setEnabled(skillDir.absolutePath, true, "user", agent, null)
        assertTrue(on["ok"]!!.jsonPrimitive.content.toBoolean())
        assertFalse(File(agent, "settings.json").readText().contains("skills"), "no exclusion entries remain")
    }

    @Test
    fun `setEnabled is idempotent and reports unchanged`() {
        val agent = agentDirWith("alpha")
        val skillDir = File(agent, "skills/alpha")

        val first = PiSkills.setEnabled(skillDir.absolutePath, false, "user", agent, null)
        assertEquals("true", first["changed"]!!.jsonPrimitive.content)
        val second = PiSkills.setEnabled(skillDir.absolutePath, false, "user", agent, null)
        assertEquals("false", second["changed"]!!.jsonPrimitive.content)
    }

    @Test
    fun `project scope writes project settings and refuses while untrusted`() {
        val project = tempDir()
        val agent = agentDirWith("alpha")
        writeSkill(File(project, ".pi/skills"), "proj-skill")
        val skillDir = File(project, ".pi/skills/proj-skill")

        val refused = PiSkills.setEnabled(skillDir.absolutePath, false, "project", agent, project.absolutePath, trusted = false)
        assertEquals("untrusted", refused["code"]!!.jsonPrimitive.content)
        assertFalse(File(project, ".pi/settings.json").exists(), "untrusted must not write")

        val allowed = PiSkills.setEnabled(skillDir.absolutePath, false, "project", agent, project.absolutePath, trusted = true)
        assertEquals("true", allowed["ok"]!!.jsonPrimitive.content)
        val written = File(project, ".pi/settings.json").readText()
        assertTrue(written.contains("-"), "the project exclusion landed in project settings")
    }

    // -- external source wiring (Q2) ------------------------------------------------

    @Test
    fun `external source toggle adds and removes the dir entry`() {
        val agent = agentDirWith("alpha")
        val dir = "C:/Users/x/.claude/skills".replace("\\", "/")

        PiSkills.setSourceEnabled(dir, true, agent)
        assertTrue(File(agent, "settings.json").readText().contains(dir), "the preset dir joined settings")

        PiSkills.setSourceEnabled(dir, false, agent)
        assertFalse(File(agent, "settings.json").readText().contains(".claude"), "the preset dir left settings")
    }

    // -- soft switch (Q3-b) -----------------------------------------------------------

    @Test
    fun `toggle model invocation edits the frontmatter line only`() {
        val skillDir = writeSkill(tempDir(), "alpha")

        val on = PiSkills.toggleModelInvocation(skillDir.absolutePath, true)
        assertEquals("true", on["changed"]!!.jsonPrimitive.content)
        val text = File(skillDir, "SKILL.md").readText()
        assertTrue(text.contains("disable-model-invocation: true"))
        assertTrue(text.contains("name: alpha"), "frontmatter survives")

        val again = PiSkills.toggleModelInvocation(skillDir.absolutePath, true)
        assertEquals("false", again["changed"]!!.jsonPrimitive.content)

        val off = PiSkills.toggleModelInvocation(skillDir.absolutePath, false)
        assertEquals("true", off["changed"]!!.jsonPrimitive.content)
        assertFalse(File(skillDir, "SKILL.md").readText().contains("disable-model-invocation"))
    }

    @Test
    fun `toggle without frontmatter is refused with a code`() {
        val dir = tempDir().resolve("bare").also { it.mkdirs() }
        File(dir, "SKILL.md").writeText("# just markdown\n")

        val result = PiSkills.toggleModelInvocation(dir.absolutePath, true)

        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertEquals("no-frontmatter", result["code"]!!.jsonPrimitive.content)
    }

    // -- matching helpers --------------------------------------------------------------

    @Test
    fun `exclusion matching covers exact file and glob forms`() {
        assertTrue(PiSkills.exclusionMatches("-C:/a/b/SKILL.md", "C:/a/b"))
        assertTrue(PiSkills.exclusionMatches("-C:/a/b", "C:/a/b"))
        assertTrue(PiSkills.exclusionMatches("!**/beta/**", "C:/agent/skills/beta"))
        assertFalse(PiSkills.exclusionMatches("!**/beta/**", "C:/agent/skills/alpha"))
        assertFalse(PiSkills.exclusionMatches("-beta", "C:/agent/skills/beta"), "bare names do not match")
    }

    @Test
    fun `exact match honors the platform case policy`() {
        val agent = agentDirWith("alpha")
        val skillDir = File(agent, "skills/alpha")
        // Same casing always matches. A case-different entry matches only on
        // Windows (case-preserving filesystem); on macOS/Linux `ALPHA` names a
        // different directory and must not cross-match.
        val sameCase = PiSkills.exclusionMatches(
            "-" + skillDir.absolutePath.replace('\\', '/') + "/SKILL.md",
            skillDir.absolutePath,
        )
        assertTrue(sameCase)
        val differentCase = PiSkills.exclusionMatches(
            "-" + skillDir.absolutePath.replace('\\', '/').replace("alpha", "ALPHA") + "/SKILL.md",
            skillDir.absolutePath,
        )
        assertEquals(dev.pi.agent.process.OsProcess.isWindows, differentCase)
    }
}
