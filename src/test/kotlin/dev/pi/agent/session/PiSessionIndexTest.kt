package dev.pi.agent.session

import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class PiSessionIndexTest {

    private val tempDir = Files.createTempDirectory("pi-sessions-test").toFile()

    @AfterTest
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    private fun writeSession(subDir: String, fileName: String, lines: List<String>) {
        val dir = File(tempDir, subDir).apply { mkdirs() }
        File(dir, fileName).writeText(lines.joinToString("\n") + "\n")
    }

    @Test
    fun `lists sessions matching project cwd from header`() {
        val header = """{"type":"session","version":3,"id":"sess-1","timestamp":"2026-10-27T10:00:00.000Z","cwd":"/proj/a"}"""
        val userMsg = """{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-27T10:00:01.000Z","message":{"role":"user","content":"Fix the login bug please"}}"""
        val info = """{"type":"session_info","id":"m2","parentId":"m1","timestamp":"2026-10-27T10:05:00.000Z","name":"Login fix"}"""
        writeSession("whatever-encoding", "s1.jsonl", listOf(header, userMsg, info))

        val otherHeader = header.replace("\"/proj/a\"", "\"/proj/b\"")
        writeSession("other", "s2.jsonl", listOf(otherHeader, userMsg))

        // Point the index at the temp root directly (no env hacks).
        val sessions = PiSessionIndex.list("/proj/a", rootOverride = tempDir)
        assertEquals(1, sessions.size)
        val s = sessions[0]
        assertEquals("sess-1", s.id)
        assertEquals("Login fix", s.name)
        assertEquals("Fix the login bug please", s.preview)
        assertEquals("/proj/a", s.cwd)
        assertTrue(s.file.endsWith("s1.jsonl"))
    }

    @Test
    fun `message counts include lines beyond the header scan window`() {
        val header = """{"type":"session","version":3,"id":"sess-2","timestamp":"2026-10-27T10:00:00.000Z","cwd":"/proj/c"}"""
        val userMsg = """{"type":"message","id":"m1","message":{"role":"user","content":"hello"}}"""
        val assistantMsg = """{"type":"message","id":"m2","message":{"role":"assistant","content":[{"type":"text","text":"hi there"}]}}"""
        val info = """{"type":"session_info","id":"m3","name":"Long session"}"""
        // The header completes within the first few lines; message counting
        // must keep going over the whole file.
        val filler = (1..50).joinToString("\n") { i -> assistantMsg.replace("\"m2\"", "\"m-$i\"") }
        writeSession("counted", "long.jsonl", listOf(header, userMsg, info, filler))

        val sessions = PiSessionIndex.list("/proj/c", rootOverride = tempDir)
        assertEquals(1, sessions.size)
        // 1 user message in the header window + 50 filler assistant messages.
        assertEquals(51, sessions[0].messageCount)
    }

    @Test
    fun `delete refuses paths outside the sessions root`() {
        val outside = File(tempDir.parentFile, "outside-${System.nanoTime()}.jsonl").apply { writeText("x") }
        try {
            assertFailsWith<IllegalStateException> {
                PiSessionIndex.deleteSessionFile(outside.absolutePath, rootOverride = tempDir)
            }
            assertTrue(outside.exists(), "file outside the root must survive")
        } finally {
            outside.delete()
        }
    }

    @Test
    fun `delete removes a session file inside the root`() {
        writeSession("deletable", "gone.jsonl", listOf("""{"type":"session","id":"gone"}"""))
        val f = File(tempDir, "deletable/gone.jsonl")
        assertTrue(f.exists())
        PiSessionIndex.deleteSessionFile(f.absolutePath, rootOverride = tempDir)
        assertTrue(!f.exists())
    }

    @Test
    fun `delete refuses a path that looks like the root itself with traversal`() {
        val sneaky = File(tempDir, "sub/../../escape.jsonl")
        assertFailsWith<IllegalStateException> {
            PiSessionIndex.deleteSessionFile(sneaky.absolutePath, rootOverride = tempDir)
        }
    }
}
