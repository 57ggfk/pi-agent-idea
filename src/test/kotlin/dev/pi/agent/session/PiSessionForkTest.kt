package dev.pi.agent.session

import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** 024 T602: the pure parts of the list-level fork (args + new-file scan). */
class PiSessionForkTest {

    private val tempDir = Files.createTempDirectory("pi-fork-test").toFile()

    @AfterTest
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    private fun writeSession(subDir: String, fileName: String, lines: List<String>): File {
        val dir = File(tempDir, subDir).apply { mkdirs() }
        return File(dir, fileName).apply { writeText(lines.joinToString("\n") + "\n") }
    }

    @Test
    fun `forkArgs spells the one-shot rpc fork command`() {
        val args = PiSessionFork.forkArgs("C:\\sessions\\a.jsonl")
        // The exact shape probe B validated: rpc mode + --fork + the file, so
        // the process forks and exits on its own (no TUI, no model call).
        assertEquals(listOf("--mode", "rpc", "--fork", "C:\\sessions\\a.jsonl"), args)
    }

    @Test
    fun `fork timeout constant stays inside the FR-006 budget`() {
        assertEquals(30L, PiSessionFork.TIMEOUT_SECONDS)
    }

    @Test
    fun `findNewFork picks the new file whose parentSession names the source`() {
        val src = writeSession(
            "src",
            "src.jsonl",
            listOf("""{"type":"session","version":3,"id":"src-1","timestamp":"t","cwd":"/proj/a"}"""),
        )
        val before = PiSessionIndex.snapshotSessionFiles(tempDir)

        // Unrelated new file (another session's own write): not a fork of src.
        writeSession(
            "noise",
            "noise.jsonl",
            listOf("""{"type":"session","version":3,"id":"noise-1","timestamp":"t","cwd":"/proj/a"}"""),
        )
        // The fork: new file, header points back at the source.
        val forked = writeSession(
            "forked",
            "forked.jsonl",
            listOf(
                """{"type":"session","version":3,"id":"fork-1","timestamp":"t","cwd":"/proj/a","parentSession":"${src.absolutePath.replace("\\", "\\\\")}"}""",
            ),
        )

        val found = PiSessionIndex.findNewFork(src.absolutePath, before, rootOverride = tempDir)
        assertEquals(forked.canonicalFile.path, found?.canonicalFile?.path)
    }

    @Test
    fun `findNewFork returns null when no new fork appeared`() {
        val src = writeSession(
            "src2",
            "src.jsonl",
            listOf("""{"type":"session","version":3,"id":"src-2","timestamp":"t","cwd":"/proj/b"}"""),
        )
        val before = PiSessionIndex.snapshotSessionFiles(tempDir)

        // Nothing new: the source itself was already in the snapshot, and a
        // file WITHOUT a matching parentSession never counts.
        assertNull(PiSessionIndex.findNewFork(src.absolutePath, before, rootOverride = tempDir))

        // A new file that appeared but does not name the source as parent.
        writeSession(
            "noise2",
            "noise.jsonl",
            listOf("""{"type":"session","version":3,"id":"noise-2","timestamp":"t","cwd":"/proj/b","parentSession":"/somewhere/else.jsonl"}"""),
        )
        assertNull(PiSessionIndex.findNewFork(src.absolutePath, before, rootOverride = tempDir))
        assertTrue(PiSessionIndex.snapshotSessionFiles(tempDir).size > before.size)
    }
}
