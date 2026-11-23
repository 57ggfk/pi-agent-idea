package dev.pi.agent.browser

import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * Spec 053 B3: the JSONL capture of console lines. The file is the agent's
 * grep channel for lines beyond the in-memory window; it lives only in the
 * IDE system dir, stores only LogSafe.truncate'd lines, and rotates so a
 * chatty page can never grow the disk usage unbounded (048 hard rule 8 —
 * nothing here touches idea.log; the class does not log at all).
 */
class ConsoleLogFileTest {

    private fun tempDir(): File = Files.createTempDirectory("pi-console-log").toFile()

    @Test
    fun `append writes one json object per line with seq index and text`() {
        val file = ConsoleLogFile(tempDir(), maxFileBytes = 1_000_000, nowMs = { 1_700_000_000_000L })
        file.append(3, "console.error: boom")
        file.append(4, "console.warning: slow \"quoted\" \\ path")

        val written = File(file.path).readLines()
        assertEquals(2, written.size)
        assertEquals(
            """{"ts":1700000000000,"seq":1,"index":3,"text":"console.error: boom"}""",
            written[0],
        )
        assertEquals(
            """{"ts":1700000000000,"seq":2,"index":4,"text":"console.warning: slow \"quoted\" \\ path"}""",
            written[1],
        )
    }

    @Test
    fun `blank text is never written`() {
        val file = ConsoleLogFile(tempDir())
        file.append(1, "")
        file.append(2, "   ")
        assertTrue(!File(file.path).exists())
    }

    @Test
    fun `file over the byte cap rotates to a numbered sibling`() {
        val dir = tempDir()
        val file = ConsoleLogFile(dir, baseName = "console", maxFileBytes = 300, nowMs = { 1L })
        for (i in 1..5) file.append(i, "console.error: line $i — ${"x".repeat(40)}")

        // A rotated sibling holds the older lines; the primary file keeps the newest.
        assertTrue(File(dir, "console.jsonl").isFile, "primary exists")
        assertTrue(File(dir, "console.1.jsonl").isFile, "console.1.jsonl exists")
        assertTrue(File(dir, "console.1.jsonl").length() >= 300, "rotated sibling holds the over-cap lines")
        assertTrue(
            File(dir, "console.jsonl").readLines().last().contains("\"index\":5"),
            "the primary keeps the newest line",
        )
    }

    @Test
    fun `rotation keeps at most keepRotated siblings`() {
        val dir = tempDir()
        val file = ConsoleLogFile(dir, baseName = "console", maxFileBytes = 200, keepRotated = 2, nowMs = { 1L })
        for (i in 1..40) file.append(i, "console.error: line $i — ${"x".repeat(40)}")

        assertTrue(File(dir, "console.1.jsonl").isFile)
        assertTrue(File(dir, "console.2.jsonl").isFile)
        assertTrue(!File(dir, "console.3.jsonl").isFile, "oldest sibling beyond keepRotated is dropped")
        // Bounded by design: lines older than the kept siblings are gone, but
        // the newest line is always in the primary and every kept line parses.
        assertTrue(
            File(dir, "console.jsonl").readLines().last().contains("\"index\":40"),
            "the newest line survives in the primary",
        )
        val keptLines = listOf("console.jsonl", "console.1.jsonl", "console.2.jsonl")
            .flatMap { name -> File(dir, name).readLines() }
        assertTrue(keptLines.size in 1..40)
        assertTrue(keptLines.all { it.startsWith("""{"ts":1,"seq":""") }, "every kept line is a JSONL record")
    }

    @Test
    fun `path points at the primary file under the given dir`() {
        val dir = tempDir()
        val file = ConsoleLogFile(dir, baseName = "console")
        assertEquals(File(dir, "console.jsonl").absolutePath, file.path)
    }
}
