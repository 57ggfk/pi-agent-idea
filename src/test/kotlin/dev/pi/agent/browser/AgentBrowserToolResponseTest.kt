package dev.pi.agent.browser

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * Spec 053 B2/B3: the pure response mappers behind AgentBrowserTool —
 * the scroll snapshot keeps the 049 response shape (scrollY inserted, no
 * reordering) and the console readback answers {ok,total,dropped,count,
 * lines,file} with the token-saving "line count + bounded preview" design.
 */
class AgentBrowserToolResponseTest {

    private fun keys(json: String): List<String> = Json.parseToJsonElement(json).jsonObject.keys.toList()

    @Test
    fun `snapshot response without scrollY keeps the 049 field order`() {
        val json = AgentBrowserTool.snapshotResponse(
            ok = true, reason = null, state = "LOADED", url = "http://127.0.0.1:3000/",
            title = "Home", ready = "complete", text = "hello",
            console = listOf("console.error: late"), autoDetected = false, candidates = emptyList(),
            scrollY = null,
        ).toString()
        assertEquals(listOf("ok", "state", "url", "title", "ready", "text", "console"), keys(json))
    }

    @Test
    fun `snapshot response with scrollY inserts it after text without reordering`() {
        val json = AgentBrowserTool.snapshotResponse(
            ok = true, reason = null, state = "LOADED", url = "http://127.0.0.1:3000/",
            title = "Home", ready = "complete", text = "hello",
            console = emptyList(), autoDetected = false, candidates = emptyList(),
            scrollY = 1200,
        ).toString()
        assertEquals(listOf("ok", "state", "url", "title", "ready", "text", "scrollY"), keys(json))
        assertTrue("\"scrollY\":1200" in json)
    }

    @Test
    fun `snapshot failure keeps reason first and keeps the detected fields on success`() {
        val failure = AgentBrowserTool.snapshotResponse(
            ok = true, reason = null, state = "LOADED", url = "http://127.0.0.1:3000/",
            title = "", ready = "", text = "",
            console = emptyList(), autoDetected = true, candidates = listOf(3000, 5173),
            scrollY = null,
        ).toString()
        assertEquals(listOf("ok", "state", "url", "title", "ready", "text", "detected", "candidates"), keys(failure))

        val failed = AgentBrowserTool.snapshotResponse(
            ok = false, reason = "read timed out; the page may still be loading or blocked", state = "TIMEOUT",
            url = "http://127.0.0.1:3000/", title = "", ready = "", text = "",
            console = emptyList(), autoDetected = false, candidates = emptyList(),
            scrollY = 800,
        ).toString()
        assertEquals(listOf("ok", "reason", "state", "url", "scrollY"), keys(failed))
    }

    @Test
    fun `console response ships counters plus the bounded line preview`() {
        val window = ConsoleWindow(
            total = 42, dropped = 7, matched = 2,
            entries = listOf(ConsoleEntry(41, "console.error: late"), ConsoleEntry(42, "console.warning: slow")),
        )
        val json = AgentBrowserTool.consoleResponse(window, since = 40, file = null)
        assertEquals(true, json["ok"]?.toString()?.toBooleanStrictOrNull() ?: false)
        assertEquals("42", json["total"].toString())
        assertEquals("7", json["dropped"].toString())
        assertEquals("2", json["count"].toString())
        assertNull(json["reason"])
        assertNull(json["file"])
        val lines = json["lines"].toString()
        assertTrue("[41] console.error: late" in lines)
        assertTrue("[42] console.warning: slow" in lines)
    }

    @Test
    fun `console response names the jsonl file when there is one`() {
        val window = ConsoleWindow(total = 1, dropped = 0, matched = 1, entries = listOf(ConsoleEntry(1, "console.error: x")))
        val json = AgentBrowserTool.consoleResponse(window, since = 0, file = "C:\\sys\\pi-agent\\browser-console\\console.jsonl")
        assertTrue("file" in json.keys)
        assertTrue("console.jsonl" in json.toString())
    }

    @Test
    fun `empty console readback stays ok with a model-readable reason`() {
        val fresh = AgentBrowserTool.consoleResponse(
            ConsoleWindow(total = 0, dropped = 0, matched = 0, entries = emptyList()), since = 0, file = null,
        )
        assertTrue("true" in fresh["ok"].toString())
        assertEquals(AgentBrowserTool.CONSOLE_EMPTY_REASON, fresh["reason"]?.toString()?.trim('"'))

        val ahead = AgentBrowserTool.consoleResponse(
            ConsoleWindow(total = 12, dropped = 0, matched = 0, entries = emptyList()), since = 30, file = null,
        )
        val reason = ahead["reason"].toString()
        assertTrue("since" in reason, "reason=$reason")
        assertTrue("12" in reason, "reason=$reason")
    }
}
