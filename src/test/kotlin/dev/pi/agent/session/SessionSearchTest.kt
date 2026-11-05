package dev.pi.agent.session

import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Full-text scan of the project's session files (spec 006 US3 / T014):
 * hit aggregation, snippet extraction, robustness against broken lines,
 * literal matching, and the scan limits.
 */
class SessionSearchTest {

    private val tempDir: File = Files.createTempDirectory("pi-session-search-test").toFile()

    @AfterTest
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    private fun writeSession(dirName: String, fileName: String, lines: List<String>) {
        val dir = File(tempDir, dirName).apply { mkdirs() }
        File(dir, fileName).writeText(lines.joinToString("\n") + "\n")
    }

    private fun header(cwd: String, id: String) =
        """{"type":"session","version":3,"id":"$id","timestamp":"2026-11-05T10:00:00.000Z","cwd":"$cwd"}"""

    private fun message(role: String, text: String) =
        """{"type":"message","id":"m-${text.hashCode()}","message":{"role":"$role","content":[{"type":"text","text":"$text"}]}}"""

    @Test
    fun `finds hits in two sessions and skips the one without a match`() {
        writeSession("a", "s1.jsonl", listOf(header("/proj/a", "sess-1"), message("user", "the uniq-token-abc plan")))
        writeSession("b", "s2.jsonl", listOf(header("/proj/a", "sess-2"), message("assistant", "uniq-token-abc details")))
        writeSession("c", "s3.jsonl", listOf(header("/proj/a", "sess-3"), message("user", "nothing relevant")))

        val outcome = searchSessions("/proj/a", "uniq-token", rootOverride = tempDir)
        assertEquals(2, outcome.results.size)
        assertTrue(outcome.results.none { it.id == "sess-3" })
        assertTrue(outcome.results.all { it.hits.isNotEmpty() && it.hits[0].snippet.contains("uniq-token") })
        assertEquals(false, outcome.truncated)
    }

    @Test
    fun `aggregates per session - hitCount counts all, hits are capped`() {
        val lines = mutableListOf(header("/proj/a", "sess-agg"))
        repeat(3) { i -> lines.add(message("user", "mention $i of uniq-token here")) }
        writeSession("agg", "agg.jsonl", lines)

        val outcome = searchSessions("/proj/a", "uniq-token", rootOverride = tempDir)
        assertEquals(1, outcome.results.size)
        assertEquals(3, outcome.results[0].hitCount)
        assertTrue(outcome.results[0].hits.size <= 2, "at most 2 snippets per session (FR-011)")
        assertEquals(0, outcome.results[0].hits[0].hitIndex)
    }

    @Test
    fun `a broken half-written line is skipped instead of crashing (FR-014)`() {
        writeSession(
            "broken", "b.jsonl",
            listOf(
                header("/proj/a", "sess-broken"),
                message("user", "before the damage"),
                """{"type":"message","message":{"role":"user","content":[{"type":"te""", // half-written
                message("assistant", "after the damage"),
            ),
        )
        val outcome = searchSessions("/proj/a", "damage", rootOverride = tempDir)
        assertEquals(1, outcome.results.size)
        assertEquals(2, outcome.results[0].hitCount)
    }

    @Test
    fun `regex metacharacters match literally`() {
        writeSession("regex", "r.jsonl", listOf(header("/proj/a", "sess-rx"), message("user", "value is a.b (c) here")))
        assertEquals(1, searchSessions("/proj/a", "a.b", rootOverride = tempDir).results.size)
        assertEquals(1, searchSessions("/proj/a", "(c)", rootOverride = tempDir).results.size)
        assertEquals(0, searchSessions("/proj/a", "aXb", rootOverride = tempDir).results.size)
    }

    @Test
    fun `more sessions than the cap reports truncated`() {
        for (i in 0 until 4) { // limit lowered via parameters
            writeSession("many$i", "m$i.jsonl", listOf(header("/proj/a", "sess-$i"), message("user", "common needle $i")))
        }
        val outcome = searchSessions("/proj/a", "needle", rootOverride = tempDir, limits = SearchLimits(maxSessions = 2))
        assertTrue(outcome.truncated, "hitting the session cap must report truncated")
        assertEquals(2, outcome.scanned)
        assertTrue(outcome.results.size <= 2)
    }

    @Test
    fun `thinking blocks and tool outputs of other projects are not scanned`() {
        writeSession("think", "t.jsonl", listOf(header("/proj/a", "sess-t"), message("assistant", "visible text")))
        val withThinking = File(tempDir, "think/t.jsonl").readText() +
            """{"type":"message","id":"m2","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hidden needle"}]}}""" + "\n"
        File(tempDir, "think/t.jsonl").writeText(withThinking)
        writeSession("other", "o.jsonl", listOf(header("/proj/b", "sess-other"), message("user", "needle elsewhere")))

        val outcome = searchSessions("/proj/a", "needle", rootOverride = tempDir)
        assertEquals(0, outcome.results.size)
    }
}
