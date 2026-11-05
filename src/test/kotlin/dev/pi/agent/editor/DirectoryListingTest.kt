package dev.pi.agent.editor

import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Directory walk for "Add Directory to Pi" (spec 009 US3 / FR-007…FR-009):
 * exclusions, output cap, depth/entry truncation, failure tolerance.
 */
class DirectoryListingTest {

    private val tempDir: Path = Files.createTempDirectory("pi-dirlisting-test")

    @AfterTest
    fun tearDown() {
        tempDir.toFile().deleteRecursively()
    }

    private fun file(rel: String) {
        val p = tempDir.resolve(rel)
        p.parent.createDirectories()
        p.writeText("x")
    }

    @Test
    fun `lists all files of a small directory`() {
        for (i in 1..12) file("F$i.kt")
        val listing = listDirectory(tempDir, projectRoot = null)
        assertEquals(12, listing.entries.size)
        assertEquals(12, listing.fileCount)
        assertEquals(0, listing.dirCount)
        assertEquals(0, listing.omitted)
        assertFalse(listing.truncated)
    }

    @Test
    fun `excludes build directories and dot-directories`() {
        file("src/Main.kt")
        file("build/out/Main.kt")
        file("node_modules/pkg/index.js")
        file(".git/config")
        file(".gradle/cache.bin")
        file("target/classes/A.class")
        file("dist/bundle.js")
        file("out/prod/A.js")
        val listing = listDirectory(tempDir, projectRoot = tempDir)
        val rel = listing.entries
        assertTrue(rel.any { it == "src/Main.kt" }, "plain files must survive: $rel")
        assertTrue(rel.none { it.startsWith("build/") }, "build/ must be excluded: $rel")
        assertTrue(rel.none { it.startsWith("node_modules/") }, "node_modules/ must be excluded")
        assertTrue(rel.none { it.startsWith(".git/") }, ".git/ must be excluded")
        assertTrue(rel.none { it.startsWith(".gradle/") }, ".gradle/ must be excluded")
        assertTrue(rel.none { it.startsWith("target/") }, "target/ must be excluded")
        assertTrue(rel.none { it.startsWith("dist/") }, "dist/ must be excluded")
        assertTrue(rel.none { it.startsWith("out/") }, "out/ must be excluded")
    }

    @Test
    fun `lists subdirectories as entries too`() {
        file("a/One.kt")
        file("a/b/Two.kt")
        val listing = listDirectory(tempDir, projectRoot = tempDir)
        assertEquals(2, listing.fileCount)
        assertEquals(2, listing.dirCount) // a/ and a/b/
        assertTrue(listing.entries.contains("a"))
        assertTrue(listing.entries.contains("a/b"))
    }

    @Test
    fun `caps the output at the limit and reports the omitted count`() {
        for (i in 1..300) file("F%03d.txt".format(i))
        val listing = listDirectory(tempDir, projectRoot = null)
        assertEquals(200, listing.entries.size)
        assertEquals(100, listing.omitted)
        assertFalse(listing.truncated, "output cap is not a traversal truncation")
    }

    @Test
    fun `deep directories mark the listing as truncated`() {
        // 15 levels deep: beyond the 12-level traversal limit.
        var p = tempDir
        for (i in 1..15) p = p.resolve("L$i")
        p.createDirectories()
        p.resolve("Deep.kt").writeText("x")
        file("Top.kt")
        val listing = listDirectory(tempDir, projectRoot = tempDir)
        assertTrue(listing.truncated, "a 15-level tree must mark truncated")
        assertTrue(listing.entries.contains("Top.kt"))
        assertTrue(listing.entries.none { it.contains("/L13") }, "nothing at or below the depth limit may be listed: ${listing.entries}")
    }

    @Test
    fun `entry cap marks the listing as truncated`() {
        // > 5000 entries across subdirectories so the walk itself hits the cap.
        val wide = tempDir.resolve("wide").createDirectories()
        for (i in 0 until 110) {
            val d = wide.resolve("D%03d".format(i)).createDirectories()
            for (j in 1 until 50) d.resolve("F$j.txt").writeText("x")
        }
        val listing = listDirectory(tempDir, projectRoot = null)
        assertTrue(listing.truncated, "5399 entries must hit the walk cap")
        assertTrue(listing.entries.size <= 200)
    }

    @Test
    fun `missing root returns an empty listing instead of throwing`() {
        val listing = listDirectory(tempDir.resolve("does-not-exist"), projectRoot = null)
        assertTrue(listing.entries.isEmpty())
        assertEquals(0, listing.omitted)
        assertFalse(listing.truncated)
    }

    @Test
    fun `paths are project-relative when the root lives inside the project`() {
        file("sub/Inner.kt")
        val listing = listDirectory(tempDir.resolve("sub"), projectRoot = tempDir)
        assertTrue(listing.entries.contains("sub/Inner.kt"), "full project-relative path, like the prompt sample: ${listing.entries}")
        assertEquals("sub", listing.root)
    }

    @Test
    fun `paths are absolute when the root is outside the project`() {
        file("Inner.kt")
        val listing = listDirectory(tempDir, projectRoot = null)
        val entry = listing.entries.single()
        assertTrue(entry.endsWith("Inner.kt") && entry.contains(":"), "absolute path outside a project: $entry")
    }

    @Test
    fun `symlinks are not followed`() {
        // Windows needs developer mode for symlinks; the guarantee is still
        // verified wherever creation succeeds (plan: skip where unsupported).
        val target = tempDir.resolve("real").createDirectories()
        target.resolve("Inside.kt").writeText("x")
        val link = tempDir.resolve("link")
        val created = runCatching { Files.createSymbolicLink(link, target) }.isSuccess
        if (!created) return
        val listing = listDirectory(tempDir, projectRoot = tempDir)
        assertTrue(listing.entries.none { it.startsWith("link/") }, "must not descend into symlinks: ${listing.entries}")
        assertTrue(listing.entries.contains("real/Inside.kt"))
    }

    // -- prompt text ----------------------------------------------------------

    @Test
    fun `prompt text shows the directory, counts and entries`() {
        file("sub/One.kt")
        file("sub/Two.kt")
        val listing = listDirectory(tempDir.resolve("sub"), projectRoot = tempDir)
        val text = directoryPromptFor(listing)
        assertTrue(text.startsWith("Here is the directory `sub` (2 files, 0 subdirectories):"), text)
        assertTrue(text.contains("sub/One.kt"))
        assertTrue(text.contains("sub/Two.kt"))
        assertTrue(text.contains("Read whatever you need."))
        assertFalse(text.contains("omitted"), "no omission note when everything fits: $text")
    }

    @Test
    fun `prompt text reports omitted and truncated honestly`() {
        for (i in 1..300) file("F%03d.txt".format(i))
        val text = directoryPromptFor(listDirectory(tempDir, projectRoot = tempDir))
        assertTrue(text.contains("100 more entries omitted"), text.takeLast(200))

        var p = tempDir.resolve("deep")
        for (i in 1..15) p = p.resolve("L$i")
        p.createDirectories()
        val deepText = directoryPromptFor(listDirectory(tempDir.resolve("deep"), projectRoot = tempDir))
        assertTrue(deepText.contains("listing stopped early"), deepText)
    }

    /**
     * Spec 009 T011: the exclusions and truncation must hold on a real
     * repository, not only on synthetic trees. Runs against this repo's own
     * checkout (gradle's working directory); skipped when the test runs
     * somewhere else.
     */
    @Test
    fun `real repository spot check excludes build artifacts and truncates`() {
        val repoRoot = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        if (!repoRoot.resolve("build.gradle.kts").toFile().isFile) return
        val listing = listDirectory(repoRoot, projectRoot = repoRoot)
        val entries = listing.entries
        assertTrue(entries.isNotEmpty(), "the repo root must list entries")
        assertTrue(entries.none { it.startsWith("build/") }, "build/ excluded: ${entries.first()}")
        assertTrue(entries.none { it.startsWith(".git/") }, ".git/ excluded")
        assertTrue(entries.none { it.startsWith("web/node_modules/") }, "web/node_modules/ excluded")
        assertTrue(entries.none { it.startsWith("dist/") }, "dist/ excluded")
        assertTrue(listing.entries.size <= 200, "output cap respected")
        assertTrue(listing.omitted > 0, "a real repo has more than 200 entries; omitted=${listing.omitted}")
        val text = directoryPromptFor(listing)
        assertTrue(text.contains("more entries omitted"), "the composer prompt must carry the omission note")
    }
}
