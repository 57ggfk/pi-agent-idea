package dev.pi.agent.process

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
 * The trust store is shared with the CLI: a bad write breaks pi everywhere.
 * These tests pin the three things that matter — path comparison, fail-safe
 * refusal on a store we cannot parse, and preserving other projects' keys.
 */
class PiTrustTest {

    private val tempDirs = mutableListOf<File>()

    private fun tempDir(): File =
        Files.createTempDirectory("pi-trust-test").toFile().also { tempDirs += it }

    @AfterTest
    fun cleanup() {
        tempDirs.forEach { runCatching { it.deleteRecursively() } }
    }

    // -- path normalisation -------------------------------------------------

    @Test
    fun `separator and case variants compare equal`() {
        val dir = tempDir()
        val native = dir.canonicalPath
        val forward = native.replace('\\', '/')
        assertEquals(
            PiTrust.normalize(native),
            PiTrust.normalize(forward),
            "D:\\a\\b and D:/a/b must resolve to the same project",
        )
        if (OsProcess.isWindows) {
            assertEquals(
                PiTrust.normalize(native),
                PiTrust.normalize(native.uppercase()),
                "NTFS is case-insensitive, so the store key may differ in case",
            )
        } else {
            // On a case-sensitive filesystem, differing case is a different project.
            assertTrue(
                PiTrust.normalize(native) != PiTrust.normalize(native.uppercase()),
                "case-sensitive platforms must not conflate differently-cased paths",
            )
        }
    }

    @Test
    fun `trailing separator is ignored`() {
        val dir = tempDir()
        val native = dir.canonicalPath
        assertEquals(PiTrust.normalize(native), PiTrust.normalize(native + File.separator))
    }

    // -- read ---------------------------------------------------------------

    @Test
    fun `missing store reads as untrusted without an error`() {
        val store = tempDir()
        val project = tempDir()
        val snap = PiTrust.snapshot(project.absolutePath, store)
        assertFalse(snap.trusted)
        assertFalse(snap.exists, "no trust.json yet is a normal first run")
        assertNull(snap.error)
    }

    @Test
    fun `corrupt store reads as untrusted and reports why`() {
        val store = tempDir()
        File(store, "trust.json").writeText("{ this is not json")
        val snap = PiTrust.snapshot(tempDir().absolutePath, store)
        assertFalse(snap.trusted, "fail-safe: unreadable store must never mean trusted")
        assertNotNull(snap.error)
    }

    @Test
    fun `trusted project is detected through a differently spelled key`() {
        val store = tempDir()
        val project = tempDir()
        val key = project.canonicalPath.replace('\\', '/')
        File(store, "trust.json").writeText("""{"$key": true}""")
        assertTrue(PiTrust.isTrusted(project.absolutePath, store))
    }

    // -- write --------------------------------------------------------------

    @Test
    fun `grant stores the project and reports it trusted`() {
        val store = tempDir()
        val project = tempDir()
        val result = PiTrust.grant(project.absolutePath, store)
        assertTrue(result.ok, result.error)
        assertTrue(File(store, "trust.json").isFile)
        val snap = PiTrust.snapshot(project.absolutePath, store)
        assertTrue(snap.trusted)
        assertEquals(1, snap.projects.size)
    }

    @Test
    fun `grant preserves other projects and stays idempotent`() {
        val store = tempDir()
        val mine = tempDir()
        val other = tempDir()
        assertTrue(PiTrust.grant(other.absolutePath, store).ok)

        assertTrue(PiTrust.grant(mine.absolutePath, store).ok)
        assertTrue(PiTrust.grant(mine.absolutePath, store).ok)

        val snap = PiTrust.snapshot(mine.absolutePath, store)
        assertTrue(snap.trusted)
        assertEquals(2, snap.projects.size, "grant must not duplicate the entry")
        assertTrue(PiTrust.isTrusted(other.absolutePath, store), "other projects must survive")
    }

    @Test
    fun `grant refuses to rewrite a corrupt store and leaves the bytes untouched`() {
        val store = tempDir()
        val project = tempDir()
        val file = File(store, "trust.json")
        val original = "{ this is not json"
        file.writeText(original)

        val result = PiTrust.grant(project.absolutePath, store)

        assertFalse(result.ok, "a store we cannot parse must not be overwritten")
        assertNotNull(result.error)
        assertEquals(original, file.readText(), "file bytes must be unchanged")
    }

    @Test
    fun `grant keeps a backup of the previous store`() {
        val store = tempDir()
        File(store, "trust.json").writeText("{}")
        assertTrue(PiTrust.grant(tempDir().absolutePath, store).ok)
        assertTrue(File(store, "trust.json.bak").isFile, "the shared store is backed up before each write")
    }

    @Test
    fun `revoke removes only the target project`() {
        val store = tempDir()
        val mine = tempDir()
        val other = tempDir()
        assertTrue(PiTrust.grant(mine.absolutePath, store).ok)
        assertTrue(PiTrust.grant(other.absolutePath, store).ok)

        val result = PiTrust.revoke(mine.absolutePath, store)

        assertTrue(result.ok, result.error)
        assertFalse(PiTrust.isTrusted(mine.absolutePath, store))
        assertTrue(PiTrust.isTrusted(other.absolutePath, store), "revoke must not touch other projects")
    }

    @Test
    fun `revoke on a missing store is a no-op success`() {
        val store = tempDir()
        val result = PiTrust.revoke(tempDir().absolutePath, store)
        assertTrue(result.ok, "revoking from an absent store is already the desired state")
        assertFalse(File(store, "trust.json").exists())
    }

    // -- resources ----------------------------------------------------------

    @Test
    fun `resources lists only categories that exist on disk`() {
        val project = tempDir()
        assertTrue(
            PiTrust.resources(project.absolutePath, trusted = false).isEmpty(),
            "an empty .pi must not produce empty groups in the UI",
        )

        File(project, ".pi/skills/demo").mkdirs()
        File(project, ".pi/skills/demo/SKILL.md").writeText("---\nname: demo\n---\n")
        File(project, ".pi/mcp.json").writeText("{}")

        val untrusted = PiTrust.resources(project.absolutePath, trusted = false)
        assertEquals(listOf("skills", "mcp"), untrusted.map { it.type })
        assertTrue(untrusted.none { it.active }, "project-local resources are inert while untrusted")
        assertTrue(untrusted.all { it.reason != null })

        val trusted = PiTrust.resources(project.absolutePath, trusted = true)
        assertTrue(trusted.all { it.active })
        assertTrue(trusted.all { it.reason == null })
    }

    @Test
    fun `blank project path yields no resources`() {
        assertTrue(PiTrust.resources(null, trusted = true).isEmpty())
        assertTrue(PiTrust.resources("", trusted = true).isEmpty())
    }
}
