package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * F-206: the console buffer's parser contract — error/warning lines survive,
 * noise and malformed payloads drop, output is truncated and never throws.
 */
class BrowserConsoleBufferTest {

    @Test
    fun `consoleAPICalled errors parse into display lines`() {
        val payload = """{"type":"error","args":[{"type":"string","value":"Uncaught TypeError: x is not a function"}]}"""
        assertEquals(
            "console.error: Uncaught TypeError: x is not a function",
            BrowserConsoleBuffer.parseLine("Runtime.consoleAPICalled", payload),
        )
    }

    @Test
    fun `console log noise is dropped`() {
        val payload = """{"type":"log","args":[{"type":"string","value":"hello"}]}"""
        assertNull(BrowserConsoleBuffer.parseLine("Runtime.consoleAPICalled", payload))
    }

    @Test
    fun `log entryAdded keeps error and warning with source`() {
        assertEquals(
            "log.error(console): failed to load resource",
            BrowserConsoleBuffer.parseLine("Log.entryAdded", """{"entry":{"level":"error","source":"console","text":"failed to load resource"}}"""),
        )
        assertEquals(
            "log.warning(network): slow request",
            BrowserConsoleBuffer.parseLine("Log.entryAdded", """{"entry":{"level":"warning","source":"network","text":"slow request"}}"""),
        )
        assertNull(
            BrowserConsoleBuffer.parseLine("Log.entryAdded", """{"entry":{"level":"verbose","text":"meh"}}"""),
        )
    }

    @Test
    fun `malformed payload degrades to null`() {
        for (payload in listOf(null, "", "not json", """{"type":"error"}""", "42")) {
            assertNull(BrowserConsoleBuffer.parseLine("Runtime.consoleAPICalled", payload), "payload=$payload")
        }
        assertNull(BrowserConsoleBuffer.parseLine("Unknown.method", """{"type":"error","args":[]}"""))
    }

    @Test
    fun `buffer keeps the most recent lines bounded`() {
        val buffer = BrowserConsoleBuffer(max = 3)
        for (i in 1..5) {
            buffer.onDevToolsEvent(
                "Runtime.consoleAPICalled",
                """{"type":"error","args":[{"value":"err $i"}]}""",
            )
        }
        val recent = buffer.recent(limit = 10)
        assertEquals(3, recent.size)
        assertTrue(recent[0].endsWith("err 3"))
        assertTrue(recent[2].endsWith("err 5"))
        assertEquals(listOf(recent[2]), buffer.recent(limit = 1))
    }

    @Test
    fun `long lines are truncated by LogSafe`() {
        val payload = """{"type":"error","args":[{"value":"${"x".repeat(500)}"}]}"""
        val line = BrowserConsoleBuffer.parseLine("Runtime.consoleAPICalled", payload)
        assertTrue(line!!.length <= LogSafe.truncate("y".repeat(500)).length + 20)
    }

    // ---- 053 B3: monotonic indexes, eviction counter, since-window readback ----

    @Test
    fun `entries carry monotonic indexes and since reads a window`() {
        val buffer = BrowserConsoleBuffer(max = 10)
        buffer.onTapLine("error", "one")
        buffer.onTapLine("warning", "two")
        buffer.onTapLine("error", "three")
        assertEquals(3, buffer.total)
        assertEquals(0, buffer.dropped)

        val window = buffer.since(1, 10)
        assertEquals(listOf(2, 3), window.map { it.index })
        assertEquals(listOf("console.warning: two", "console.error: three"), window.map { it.text })

        assertEquals(emptyList(), buffer.since(3, 10))
        assertEquals(listOf(2), buffer.since(1, 1).map { it.index })
        assertEquals(emptyList(), buffer.since(2, 0).map { it.index })
    }

    @Test
    fun `ring eviction counts toward dropped while total keeps counting`() {
        val buffer = BrowserConsoleBuffer(max = 3)
        for (i in 1..5) buffer.onTapLine("error", "e$i")
        assertEquals(5, buffer.total)
        assertEquals(2, buffer.dropped)
        assertEquals(listOf(3, 4, 5), buffer.since(0, 10).map { it.index })
    }

    @Test
    fun `default capacity is 300`() {
        val buffer = BrowserConsoleBuffer()
        for (i in 1..301) buffer.onTapLine("error", "e$i")
        assertEquals(301, buffer.total)
        assertEquals(1, buffer.dropped)
        assertEquals(300, buffer.since(0, 1000).size)
        assertEquals(301, buffer.since(300, 1000).first().index)
    }

    @Test
    fun `clear empties the ring but keeps the monotonic counters`() {
        val buffer = BrowserConsoleBuffer(max = 5)
        buffer.onTapLine("error", "one")
        buffer.onTapLine("error", "two")
        buffer.clear()
        assertEquals(emptyList(), buffer.since(0, 10))
        assertEquals(2, buffer.total)
        assertEquals(0, buffer.dropped)
    }

    @Test
    fun `severity filter stays error and warning only`() {
        val buffer = BrowserConsoleBuffer()
        buffer.onTapLine("info", "noise")
        buffer.onTapLine("debug", "noise")
        buffer.onDevToolsEvent("Runtime.consoleAPICalled", """{"type":"log","args":[{"value":"hello"}]}""")
        assertEquals(0, buffer.total)
    }

    @Test
    fun `accepted lines flow to the sink with their index`() {
        val seen = mutableListOf<ConsoleEntry>()
        val buffer = BrowserConsoleBuffer(max = 5, sink = { seen.add(it) })
        buffer.onTapLine("error", "boom")
        buffer.onDevToolsEvent("Runtime.consoleAPICalled", """{"type":"warning","args":[{"value":"slow"}]}""")
        buffer.onTapLine("info", "ignored")
        assertEquals(2, seen.size)
        assertEquals(1, seen[0].index)
        assertEquals("console.error: boom", seen[0].text)
        assertEquals(2, seen[1].index)
        assertEquals("console.warning: slow", seen[1].text)
    }
}
