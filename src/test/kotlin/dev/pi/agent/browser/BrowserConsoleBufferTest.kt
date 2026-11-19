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
}
