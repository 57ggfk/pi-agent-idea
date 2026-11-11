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

    private fun sessionWith(cwd: String, id: String, name: String?): List<String> {
        val header = """{"type":"session","version":3,"id":"$id","timestamp":"2026-10-27T10:00:00.000Z","cwd":"$cwd"}"""
        val userMsg = """{"type":"message","id":"m1","message":{"role":"user","content":"hello"}}"""
        return if (name == null) listOf(header, userMsg)
        else listOf(header, userMsg, """{"type":"session_info","id":"m2","name":"$name"}""")
    }

    @Test
    fun `rename appends a pi-shaped session_info entry and the list takes the new name`() {
        writeSession("renamed", "r.jsonl", sessionWith("/proj/r", "sess-r", "First name"))
        val f = File(tempDir, "renamed/r.jsonl")

        PiSessionIndex.renameSessionFile(f.absolutePath, "Second name", rootOverride = tempDir)

        // The appended record is a real pi entry: one compact JSON line with
        // id, parentId (the file's leaf), timestamp and the sanitised name.
        val appended = f.readLines().last { it.isNotBlank() }
        assertTrue(appended.startsWith("""{"type":"session_info","""), appended)
        assertTrue(""""name":"Second name"""" in appended, appended)
        assertTrue(""""parentId":"m2"""" in appended, appended)

        val sessions = PiSessionIndex.list("/proj/r", rootOverride = tempDir)
        assertEquals(1, sessions.size)
        assertEquals("Second name", sessions[0].name)
    }

    @Test
    fun `rename twice keeps the newest name even though the header completed earlier`() {
        writeSession("twice", "t.jsonl", sessionWith("/proj/t", "sess-t", "First name"))
        val f = File(tempDir, "twice/t.jsonl")
        PiSessionIndex.renameSessionFile(f.absolutePath, "Second name", rootOverride = tempDir)
        PiSessionIndex.renameSessionFile(f.absolutePath, "Third name", rootOverride = tempDir)

        // pi's own list takes the LAST session_info; the index must not stop
        // scanning once id+name+preview are all found.
        val sessions = PiSessionIndex.list("/proj/t", rootOverride = tempDir)
        assertEquals(1, sessions.size)
        assertEquals("Third name", sessions[0].name)
    }

    @Test
    fun `rename sanitises line breaks like pi and refuses a blank name`() {
        writeSession("sanitised", "s.jsonl", sessionWith("/proj/s", "sess-s", null))
        val f = File(tempDir, "sanitised/s.jsonl")

        PiSessionIndex.renameSessionFile(f.absolutePath, "two\r\nlines", rootOverride = tempDir)
        val appended = f.readLines().last { it.isNotBlank() }
        assertTrue(""""name":"two lines"""" in appended, appended)

        assertFailsWith<IllegalStateException> {
            PiSessionIndex.renameSessionFile(f.absolutePath, "   \r\n  ", rootOverride = tempDir)
        }
    }

    @Test
    fun `rename heals a missing trailing newline instead of concatenating onto the last entry`() {
        val dir = File(tempDir, "noeol").apply { mkdirs() }
        val f = File(dir, "n.jsonl")
        // Deliberately no trailing newline: pi may have died mid-write.
        f.writeText(sessionWith("/proj/n", "sess-n", null).joinToString("\n"))

        PiSessionIndex.renameSessionFile(f.absolutePath, "clean line", rootOverride = tempDir)

        val lines = f.readLines().filter { it.isNotBlank() }
        assertEquals(3, lines.size, "the rename must land on its own line")
        assertTrue(lines.last().startsWith("""{"type":"session_info","""), lines.last())
        assertEquals("clean line", PiSessionIndex.list("/proj/n", rootOverride = tempDir)[0].name)
    }

    @Test
    fun `rename refuses paths outside the sessions root`() {
        val outside = File(tempDir.parentFile, "outside-${System.nanoTime()}.jsonl").apply { writeText("x") }
        try {
            assertFailsWith<IllegalStateException> {
                PiSessionIndex.renameSessionFile(outside.absolutePath, "nope", rootOverride = tempDir)
            }
            assertTrue(outside.exists(), "file outside the root must survive")
        } finally {
            outside.delete()
        }
    }

    // -- 021 US4: two-phase read + per-file cache ------------------------------

    @Test
    fun `only the target project's files are read past their header`() {
        // Three projects, two sessions each. Phase 1 must look at every header
        // (that is the only way to know the cwd) but phase 2 may only open the
        // two files that belong to the requested project.
        for (project in listOf("a", "b", "c")) {
            writeSession("proj-$project", "$project-1.jsonl", sessionWith("/proj/$project", "id-$project-1", "n1"))
            writeSession("proj-$project", "$project-2.jsonl", sessionWith("/proj/$project", "id-$project-2", "n2"))
        }

        PiSessionIndex.resetReadCounters()
        val sessions = PiSessionIndex.list("/proj/b", rootOverride = tempDir)

        assertEquals(2, sessions.size)
        assertEquals(6, PiSessionIndex.headerReads.get(), "every header must be inspected")
        assertEquals(2, PiSessionIndex.bodyReads.get(), "other projects' bodies must stay unread")
    }

    @Test
    fun `a file without a session header is skipped and remembered as such`() {
        writeSession("broken", "bad.jsonl", listOf("""{"type":"message","message":{"role":"user","content":"x"}}"""))
        writeSession("good", "ok.jsonl", sessionWith("/proj/x", "id-x", "ok"))

        PiSessionIndex.resetReadCounters()
        assertEquals(1, PiSessionIndex.list("/proj/x", rootOverride = tempDir).size)

        // Second pass: the negative result comes from the cache.
        PiSessionIndex.resetReadCounters()
        assertEquals(1, PiSessionIndex.list("/proj/x", rootOverride = tempDir).size)
        assertEquals(0, PiSessionIndex.headerReads.get(), "a cached miss must not re-read")
        assertEquals(0, PiSessionIndex.bodyReads.get(), "a cached summary must not re-read")
    }

    @Test
    fun `a changed file invalidates its cached summary`() {
        writeSession("cache", "c.jsonl", sessionWith("/proj/k", "id-k", "First name"))
        val f = File(tempDir, "cache/c.jsonl")
        assertEquals("First name", PiSessionIndex.list("/proj/k", rootOverride = tempDir)[0].name)

        PiSessionIndex.renameSessionFile(f.absolutePath, "Renamed later", rootOverride = tempDir)

        assertEquals("Renamed later", PiSessionIndex.list("/proj/k", rootOverride = tempDir)[0].name)
    }
}
