package dev.pi.agent.browser

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * Spec 065 B2/B3: the pure response mappers behind AgentBrowserTool —
 * the scroll snapshot keeps the 061 response shape (scrollY inserted, no
 * reordering) and the console readback answers {ok,total,dropped,count,
 * lines,file} with the token-saving "line count + bounded preview" design.
 */
class AgentBrowserToolResponseTest {

    private fun keys(json: String): List<String> = Json.parseToJsonElement(json).jsonObject.keys.toList()

    @Test
    fun `snapshot response without scrollY keeps the 061 field order`() {
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

    // ---- 068: tab addressing — the "tab" field rides at the tail of every answer ----

    @Test
    fun `tab stamps the tail of an ok snapshot without disturbing the locked order`() {
        val json = AgentBrowserTool.snapshotResponse(
            ok = true, reason = null, state = "LOADED", url = "http://127.0.0.1:3000/",
            title = "Home", ready = "complete", text = "hello",
            console = listOf("console.error: late"), autoDetected = false, candidates = emptyList(),
            scrollY = 900, tab = "t1",
        ).toString()
        assertEquals(
            listOf("ok", "state", "url", "title", "ready", "text", "scrollY", "console", "tab"),
            keys(json),
            "tab is the LAST field; the 061/065 order before it is untouched",
        )
        assertTrue("\"tab\":\"t1\"" in json)
    }

    @Test
    fun `tab stamps the tail of a failure snapshot too`() {
        val json = AgentBrowserTool.snapshotResponse(
            ok = false, reason = "read timed out; the page may still be loading or blocked", state = "TIMEOUT",
            url = "http://127.0.0.1:3000/", title = "", ready = "", text = "",
            console = emptyList(), autoDetected = false, candidates = emptyList(),
            scrollY = null, tab = "e2",
        ).toString()
        assertEquals(listOf("ok", "reason", "state", "url", "tab"), keys(json))
        assertTrue("\"tab\":\"e2\"" in json)
    }

    @Test
    fun `tab-less responses omit the field entirely`() {
        val json = AgentBrowserTool.snapshotResponse(
            ok = true, reason = null, state = "LOADED", url = "http://x/", title = "", ready = "", text = "",
            console = emptyList(), autoDetected = false, candidates = emptyList(),
            scrollY = null, tab = null,
        ).toString()
        assertTrue("\"tab\"" !in json, "a panel with no id must not fabricate a tab field")
    }

    @Test
    fun `console response carries the tab at the tail`() {
        val window = ConsoleWindow(total = 1, dropped = 0, matched = 1, entries = listOf(ConsoleEntry(1, "console.error: x")))
        val json = AgentBrowserTool.consoleResponse(window, since = 0, file = null, tab = "t2")
        assertEquals(listOf("ok", "total", "dropped", "count", "lines", "tab"), keys(json.toString()))
        assertTrue("\"tab\":\"t2\"" in json.toString())
    }

    @Test
    fun `list response enumerates tabs with the locked wire shape`() {
        val json = AgentBrowserTool.listResponse(
            listOf(
                BrowserTabSummary("t1", "http://127.0.0.1:3000/", "Home", "tab", selected = true),
                BrowserTabSummary("e1", "file:///D:/demo/bubbles.html", "bubbles", "editor", selected = false),
            ),
        )
        val obj = Json.parseToJsonElement(json.toString()).jsonObject
        assertEquals(true, obj["ok"]?.toString()?.toBooleanStrictOrNull() ?: false)
        val tabs = obj["tabs"]!!.toString()
        // Per-tab field order is locked: tab, url, title, carrier, selected.
        assertTrue(
            """"tab":"t1","url":"http://127.0.0.1:3000/","title":"Home","carrier":"tab","selected":true""" in tabs,
            "tabs=$tabs",
        )
        assertTrue(
            """"tab":"e1","url":"file:///D:/demo/bubbles.html","title":"bubbles","carrier":"editor","selected":false""" in tabs,
            "tabs=$tabs",
        )
    }

    @Test
    fun `list response with no live tabs stays ok with an empty array`() {
        val json = AgentBrowserTool.listResponse(emptyList()).toString()
        assertEquals(listOf("ok", "tabs"), keys(json))
        assertTrue("\"tabs\":[]" in json)
    }

    // ---- 069: the operation layer — action fields ride the snapshot answer ----

    @Test
    fun `action fields sit between console and tab without disturbing the locked order`() {
        val json = AgentBrowserTool.snapshotResponse(
            ok = true, reason = null, state = "LOADED", url = "http://127.0.0.1:3000/",
            title = "Home", ready = "complete", text = "hello",
            console = listOf("console.error: late"), autoDetected = false, candidates = emptyList(),
            scrollY = null, tab = "t1",
            actionFields = buildJsonObject {
                put("found", true)
                put("tag", "button")
                put("elementText", "Submit order")
            },
        ).toString()
        assertEquals(
            listOf("ok", "state", "url", "title", "ready", "text", "console", "found", "tag", "elementText", "tab"),
            keys(json),
            "the click verdict rides at the tail; tab stays the very last field",
        )
        assertTrue("\"found\":true" in json)
        assertTrue("\"elementText\":\"Submit order\"" in json)
    }

    @Test
    fun `action failure answers carry reason error url and tab in that order`() {
        val json = AgentBrowserTool.actionFailure(
            reason = "evaluate failed: ReferenceError: boom is not defined",
            error = "ReferenceError: boom is not defined",
            url = "http://127.0.0.1:3000/",
            tab = "e1",
        ).toString()
        assertEquals(listOf("ok", "reason", "error", "url", "tab"), keys(json))

        // Transport-level failures (no page / timeout / in-flight) have no
        // page-side error to name — the error field is omitted.
        val plain = AgentBrowserTool.actionFailure(
            reason = "action timed out; the page may still be loading or blocked",
            error = null, url = "", tab = "t2",
        ).toString()
        assertEquals(listOf("ok", "reason", "tab"), keys(plain))
    }
}
