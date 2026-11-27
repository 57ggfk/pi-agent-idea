package dev.pi.agent.manage

import dev.pi.agent.manage.PiSkills.settingsPathFor
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Issue #13: an external skill source is written into pi's settings.json.
 *
 * The plugin wrote the absolute path (`C:/Users/me/.claude/skills`), which
 * ties the file to one machine. pi expands a leading `~` itself
 * (dist/utils/paths.js `normalizePath` → `join(home, …)`), so the short
 * form is what the settings file should carry.
 *
 * Verified against the installed pi 1.6.1:
 *  - dist/utils/paths.js: normalizePath() expands "~/" via join(home, …)
 *  - dist/core/package-manager.js: resolveLocalEntries() →
 *    resolvePathFromBase() → resolvePath(…, {homeDir}) → normalizePath()
 *  - empirical probe: resolvePath("~/.claude/skills") =
 *    "C:\\Users\\Administrator\\.claude\\skills"
 */
class Issue13SkillsSourcePathTest {

    private val home = File("C:/Users/me")

    private fun tempDir(): File =
        java.nio.file.Files.createTempDirectory("pi-13-test").toFile()

    @Test
    fun `a path under the home is written in the short form`() {
        assertEquals("~/.claude/skills", settingsPathFor("C:/Users/me/.claude/skills", home))
    }

    @Test
    fun `the short form keeps the separators pi expects`() {
        assertEquals("~/.claude/skills", settingsPathFor("C:\\Users\\me\\.claude\\skills", home))
    }

    @Test
    fun `a path outside the home stays absolute`() {
        assertEquals(
            "D:/opt/skills",
            settingsPathFor("D:/opt/skills", home),
        )
    }

    @Test
    fun `a sibling directory whose name starts like the home is not shortened`() {
        // "C:/Users/meister/..." is NOT under "C:/Users/me".
        assertEquals("C:/Users/meister/skills", settingsPathFor("C:/Users/meister/skills", home))
    }

    @Test
    fun `the home itself is written as a bare tilde`() {
        assertEquals("~", settingsPathFor("C:/Users/me", home))
    }

    @Test
    fun `an already short path is left alone`() {
        assertEquals("~/.claude/skills", settingsPathFor("~/.claude/skills", home))
    }

    @Test
    fun `the short form round-trips back to the absolute path`() {
        val absolute = "C:/Users/me/.claude/skills"
        val short = settingsPathFor(absolute, home)
        assertTrue(short.startsWith("~/"))
        assertEquals(absolute, File(home, short.removePrefix("~/")).path.replace('\\', '/'))
    }

    @Test
    fun `a blank path is not shortened into a bogus tilde`() {
        assertFalse(settingsPathFor("", home).startsWith("~"))
    }

    // -- the write path end to end ---------------------------------------------

    @Test
    fun `an external source under the home is written in the short form`() {
        val agent = tempDir()
        val userHome = tempDir()
        val dir = File(userHome, ".claude/skills").absolutePath.replace('\\', '/')

        PiSkills.setSourceEnabled(dir, true, agent, userHome)

        val written = File(agent, "settings.json").readText()
        assertTrue(written.contains("~/.claude/skills"), "the short form is written: $written")
        assertFalse(written.contains(userHome.absolutePath.replace('\\', '/')), "the home must not be spelled out")
    }

    @Test
    fun `an external source outside the home is written absolute`() {
        val agent = tempDir()
        val userHome = tempDir()
        val dir = File(tempDir(), "skills").absolutePath.replace('\\', '/')

        PiSkills.setSourceEnabled(dir, true, agent, userHome)

        assertTrue(File(agent, "settings.json").readText().contains(dir))
    }

    @Test
    fun `a short entry is recognised and removed again`() {
        val agent = tempDir()
        val userHome = tempDir()
        val dir = File(userHome, ".claude/skills").absolutePath.replace('\\', '/')

        PiSkills.setSourceEnabled(dir, true, agent, userHome)
        PiSkills.setSourceEnabled(dir, false, agent, userHome)

        assertFalse(
            File(agent, "settings.json").readText().contains(".claude"),
            "the short entry is removed again",
        )
    }

    @Test
    fun `enabling twice does not duplicate the entry`() {
        val agent = tempDir()
        val userHome = tempDir()
        val dir = File(userHome, ".claude/skills").absolutePath.replace('\\', '/')

        PiSkills.setSourceEnabled(dir, true, agent, userHome)
        PiSkills.setSourceEnabled(dir, true, agent, userHome)

        val written = File(agent, "settings.json").readText()
        assertEquals(1, Regex("claude/skills").findAll(written).count(), "one entry only: $written")
    }

    @Test
    fun `a short entry is expanded back when the sources are listed`() {
        val agent = tempDir()
        val userHome = tempDir()
        val skillsDir = File(userHome, ".claude/skills")
        File(skillsDir, "alpha").mkdirs()
        File(skillsDir, "alpha/SKILL.md").writeText("---\nname: alpha\ndescription: d\n---\n")

        PiSkills.setSourceEnabled(skillsDir.absolutePath.replace('\\', '/'), true, agent, userHome)

        val listing = PiSkills.list(agent, userHome, null)
        assertEquals(
            listOf(skillsDir.absolutePath.replace('\\', '/')),
            listing.externalSources,
            "the short entry is listed as the absolute dir",
        )
    }
}
