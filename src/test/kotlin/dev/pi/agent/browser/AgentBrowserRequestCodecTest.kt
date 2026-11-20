package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * Spec 049 B2: the /agent-browser request contract. The endpoint answers
 * malformed requests with a model-readable reason (not a transport error),
 * and bridge-token URLs are refused before any navigation (048 hard rule 1).
 */
class AgentBrowserRequestCodecTest {

    @Test
    fun `parses open read reload`() {
        val open = AgentBrowserRequestCodec.parse("""{"action":"open","url":"http://127.0.0.1:3000/"}""")
        assertEquals(AgentAction.OPEN, assertIs<AgentParseResult.Valid>(open).request.action)
        assertEquals("http://127.0.0.1:3000/", (open as AgentParseResult.Valid).request.url)

        val read = AgentBrowserRequestCodec.parse("""{"action":"read"}""")
        assertEquals(AgentAction.READ, (read as AgentParseResult.Valid).request.action)

        val reload = AgentBrowserRequestCodec.parse("""{"action":"reload","url":"http://x/"}""")
        assertEquals(AgentAction.RELOAD, (reload as AgentParseResult.Valid).request.action)
    }

    @Test
    fun `malformed bodies degrade to model-readable reasons`() {
        // {"action":"open"} is VALID since F-214 (url-less open = auto-detect).
        for (body in listOf(null, "", "not json", "{}", """{"action":"delete"}""", """{"action":"reload"}""")) {
            val parsed = AgentBrowserRequestCodec.parse(body)
            assertIs<AgentParseResult.Invalid>(parsed, "body=$body")
        }
    }

    @Test
    fun `open without url is the auto-detect contract but reload needs one`() {
        // F-214: url-less OPEN parses; the probe runs in the tool, not here.
        val open = AgentBrowserRequestCodec.parse("""{"action":"open"}""")
        assertEquals(AgentAction.OPEN, (open as AgentParseResult.Valid).request.action)
        assertNull(open.request.url)
        assertIs<AgentParseResult.Valid>(AgentBrowserRequestCodec.parse("""{"action":"read","url":""}"""))
        assertIs<AgentParseResult.Invalid>(AgentBrowserRequestCodec.parse("""{"action":"reload"}"""))
    }

    @Test
    fun `bridge token in url is refused for every navigational action`() {
        val token = "s3cr3t-token"
        val url = "http://127.0.0.1:51234/?token=$token&instance=1"
        assertEquals(
            "url contains the IDE bridge token and is refused for the browser tab",
            AgentBrowserRequestCodec.bridgeTokenViolation(url, token),
        )
        // Same URL without a token to check against is not a violation here —
        // the check is advisory-free: no token minted (chat never opened) means
        // nothing to protect.
        assertNull(AgentBrowserRequestCodec.bridgeTokenViolation(url, null))
        assertNull(AgentBrowserRequestCodec.bridgeTokenViolation("http://127.0.0.1:3000/", token))
    }

    // ---- 054: agent dual-form target (tool-window tab vs editor-form preview) ----

    @Test
    fun `parses target and rejects values outside the carrier set`() {
        val open = AgentBrowserRequestCodec.parse("""{"action":"open","url":"http://127.0.0.1:3000/","target":"editor"}""")
        assertEquals("editor", (open as AgentParseResult.Valid).request.target)

        val tab = AgentBrowserRequestCodec.parse("""{"action":"read","target":"tab"}""")
        assertEquals("tab", (tab as AgentParseResult.Valid).request.target)

        val absent = AgentBrowserRequestCodec.parse("""{"action":"read"}""")
        assertNull((absent as AgentParseResult.Valid).request.target, "target-less body parses like the pre-054 contract")

        val invalid = AgentBrowserRequestCodec.parse("""{"action":"read","target":"window"}""")
        assertEquals(
            "target must be \"tab\" or \"editor\"",
            (invalid as AgentParseResult.Invalid).reason,
            "the model must see which values exist instead of a silent ignore",
        )
    }

    // ---- 053: scroll + console actions, read selector/format (spec 053 B1) ----

    @Test
    fun `parses scroll with direction and clamped amount`() {
        val scroll = AgentBrowserRequestCodec.parse("""{"action":"scroll","direction":"up","amount":500}""")
        val req = assertIs<AgentParseResult.Valid>(scroll).request
        assertEquals(AgentAction.SCROLL, req.action)
        assertEquals("up", req.scrollDirection)
        assertEquals(500, req.scrollAmount)

        // Amount clamps into 1..10000; direction defaults to null (the tool
        // picks "down") and absent params stay null, not 0.
        assertEquals(
            1,
            (AgentBrowserRequestCodec.parse("""{"action":"scroll","amount":0}""") as AgentParseResult.Valid)
                .request.scrollAmount,
        )
        assertEquals(
            AgentBrowserRequestCodec.MAX_SCROLL_AMOUNT,
            (AgentBrowserRequestCodec.parse("""{"action":"scroll","amount":999999}""") as AgentParseResult.Valid)
                .request.scrollAmount,
        )
        val bare = (AgentBrowserRequestCodec.parse("""{"action":"scroll"}""") as AgentParseResult.Valid).request
        assertEquals(AgentAction.SCROLL, bare.action)
        assertNull(bare.scrollDirection)
        assertNull(bare.scrollAmount)
    }

    @Test
    fun `parses console limit and since with clamping`() {
        val console = AgentBrowserRequestCodec.parse("""{"action":"console","limit":5,"since":12}""")
        val req = assertIs<AgentParseResult.Valid>(console).request
        assertEquals(AgentAction.CONSOLE, req.action)
        assertEquals(5, req.consoleLimit)
        assertEquals(12, req.consoleSince)

        assertEquals(
            1,
            (AgentBrowserRequestCodec.parse("""{"action":"console","limit":0}""") as AgentParseResult.Valid)
                .request.consoleLimit,
        )
        assertEquals(
            AgentBrowserRequestCodec.MAX_CONSOLE_LIMIT,
            (AgentBrowserRequestCodec.parse("""{"action":"console","limit":99999}""") as AgentParseResult.Valid)
                .request.consoleLimit,
        )
        assertEquals(
            0,
            (AgentBrowserRequestCodec.parse("""{"action":"console","since":-3}""") as AgentParseResult.Valid)
                .request.consoleSince,
        )
        val bare = (AgentBrowserRequestCodec.parse("""{"action":"console"}""") as AgentParseResult.Valid).request
        assertNull(bare.consoleLimit)
        assertNull(bare.consoleSince)
    }

    @Test
    fun `parses read selector and format for the structured excerpt`() {
        val read = AgentBrowserRequestCodec.parse("""{"action":"read","selector":"#root > .item","format":"html"}""")
        val req = assertIs<AgentParseResult.Valid>(read).request
        assertEquals(AgentAction.READ, req.action)
        assertEquals("#root > .item", req.selector)
        assertEquals("html", req.format)

        // Unknown format value degrades; selector alone is fine (format defaults).
        assertTrue(
            AgentBrowserRequestCodec.parse("""{"action":"read","format":"png"}""") is AgentParseResult.Invalid,
        )
        val bare = (AgentBrowserRequestCodec.parse("""{"action":"read","selector":"table"}""") as AgentParseResult.Valid)
            .request
        assertEquals("table", bare.selector)
        assertNull(bare.format)
    }

    @Test
    fun `invalid direction and unknown parameters degrade to model-readable reasons`() {
        val badDirection = AgentBrowserRequestCodec.parse("""{"action":"scroll","direction":"sideways"}""")
        val dirReason = assertIs<AgentParseResult.Invalid>(badDirection).reason
        assertTrue("direction" in dirReason, "reason=$dirReason")

        val badAmount = AgentBrowserRequestCodec.parse("""{"action":"scroll","amount":"abc"}""")
        val amountReason = assertIs<AgentParseResult.Invalid>(badAmount).reason
        assertTrue("amount" in amountReason, "reason=$amountReason")

        val unknownParam = AgentBrowserRequestCodec.parse("""{"action":"read","selctor":"#a"}""")
        val paramReason = assertIs<AgentParseResult.Invalid>(unknownParam).reason
        assertTrue("\"selctor\"" in paramReason, "reason=$paramReason")
        assertTrue("limit" in paramReason, "reason should list the known parameters: $paramReason")
    }

    // ---- 056: tab addressing (tab id param + list action) ----

    @Test
    fun `parses the list action`() {
        val list = AgentBrowserRequestCodec.parse("""{"action":"list"}""")
        assertEquals(AgentAction.LIST, (list as AgentParseResult.Valid).request.action)
    }

    @Test
    fun `parses tab ids for any action`() {
        assertEquals(
            "t1",
            (AgentBrowserRequestCodec.parse("""{"action":"read","tab":"t1"}""") as AgentParseResult.Valid).request.tab,
        )
        assertEquals(
            "e12",
            (AgentBrowserRequestCodec.parse("""{"action":"open","url":"http://127.0.0.1:3000/","tab":"e12"}""") as AgentParseResult.Valid).request.tab,
        )
        assertEquals(
            "t10",
            (AgentBrowserRequestCodec.parse("""{"action":"scroll","tab":"t10","direction":"up"}""") as AgentParseResult.Valid).request.tab,
        )
        assertNull(
            (AgentBrowserRequestCodec.parse("""{"action":"read"}""") as AgentParseResult.Valid).request.tab,
            "tab-less body parses like the pre-056 contract",
        )
    }

    @Test
    fun `malformed tab ids fail the codec format check`() {
        // Format errors are codec-level; an id that LOOKS right but names no
        // live panel is a runtime miss (the tool answers "no browser tab t9").
        for (tab in listOf("t0", "x1", "T1", "tab", "editor", "t", "t01", "1t", "t1.5")) {
            val parsed = AgentBrowserRequestCodec.parse("""{"action":"read","tab":"$tab"}""")
            val reason = assertIs<AgentParseResult.Invalid>(parsed, "tab=$tab").reason
            assertTrue("tab" in reason, "tab=$tab reason=$reason")
        }
    }

    @Test
    fun `tab and target are both legal in one body`() {
        // The codec accepts both; the TOOL layer gives the narrower address
        // (tab) precedence over the form (target).
        val parsed = AgentBrowserRequestCodec.parse(
            """{"action":"read","tab":"e2","target":"tab"}""",
        )
        val req = assertIs<AgentParseResult.Valid>(parsed).request
        assertEquals("e2", req.tab)
        assertEquals("tab", req.target)
    }

    // ---- 057: the operation layer (click / type / evaluate) ----

    @Test
    fun `parses click type evaluate with their payloads`() {
        val click = AgentBrowserRequestCodec.parse("""{"action":"click","selector":"#btn","tab":"t1"}""")
        val clickReq = assertIs<AgentParseResult.Valid>(click).request
        assertEquals(AgentAction.CLICK, clickReq.action)
        assertEquals("#btn", clickReq.selector)
        assertEquals("t1", clickReq.tab)

        val type = AgentBrowserRequestCodec.parse("""{"action":"type","selector":"#inp","text":"你好 pi"}""")
        val typeReq = assertIs<AgentParseResult.Valid>(type).request
        assertEquals(AgentAction.TYPE, typeReq.action)
        assertEquals("#inp", typeReq.selector)
        assertEquals("你好 pi", typeReq.text)

        val evaluate = AgentBrowserRequestCodec.parse("""{"action":"evaluate","js":"document.title"}""")
        val evalReq = assertIs<AgentParseResult.Valid>(evaluate).request
        assertEquals(AgentAction.EVALUATE, evalReq.action)
        assertEquals("document.title", evalReq.js)
    }

    @Test
    fun `click and type require a selector and type requires text`() {
        val noSelector = AgentBrowserRequestCodec.parse("""{"action":"click"}""")
        assertTrue("selector" in (noSelector as AgentParseResult.Invalid).reason, "reason=${noSelector.reason}")

        val typeNoText = AgentBrowserRequestCodec.parse("""{"action":"type","selector":"#inp"}""")
        assertTrue("text" in (typeNoText as AgentParseResult.Invalid).reason, "reason=${typeNoText.reason}")

        val evaluateNoJs = AgentBrowserRequestCodec.parse("""{"action":"evaluate"}""")
        assertTrue("js" in (evaluateNoJs as AgentParseResult.Invalid).reason, "reason=${evaluateNoJs.reason}")
    }

    @Test
    fun `action payloads enforce the length caps with model-readable errors`() {
        // selector at the cap parses; one over it is rejected (not truncated).
        val atCap = AgentBrowserRequestCodec.parse("""{"action":"click","selector":"#${"a".repeat(199)}"}""")
        assertEquals(
            AgentBrowserRequestCodec.MAX_SELECTOR_CHARS,
            (atCap as AgentParseResult.Valid).request.selector?.length,
        )
        val over = AgentBrowserRequestCodec.parse("""{"action":"click","selector":"#${"a".repeat(200)}"}""")
        assertTrue("200" in (over as AgentParseResult.Invalid).reason, "reason=${over.reason}")

        val atTextCap = AgentBrowserRequestCodec.parse("""{"action":"type","selector":"#inp","text":"${"b".repeat(5000)}"}""")
        assertEquals(
            AgentBrowserRequestCodec.MAX_ACTION_TEXT_CHARS,
            (atTextCap as AgentParseResult.Valid).request.text?.length,
        )
        val overText = AgentBrowserRequestCodec.parse("""{"action":"type","selector":"#inp","text":"${"b".repeat(5001)}"}""")
        assertTrue("5000" in (overText as AgentParseResult.Invalid).reason, "reason=${overText.reason}")

        val atJsCap = AgentBrowserRequestCodec.parse("""{"action":"evaluate","js":"${"x".repeat(10000)}"}""")
        assertEquals(
            AgentBrowserRequestCodec.MAX_EVALUATE_JS_CHARS,
            (atJsCap as AgentParseResult.Valid).request.js?.length,
        )
        val overJs = AgentBrowserRequestCodec.parse("""{"action":"evaluate","js":"${"x".repeat(10001)}"}""")
        assertTrue("10000" in (overJs as AgentParseResult.Invalid).reason, "reason=${overJs.reason}")
    }

    @Test
    fun `read keeps its 053 selector truncation unchanged`() {
        // The red line: the observation side behaves exactly as it did — only
        // the 057 actions reject over-long selectors.
        val read = AgentBrowserRequestCodec.parse("""{"action":"read","selector":"${"c".repeat(250)}"}""")
        assertEquals(200, (read as AgentParseResult.Valid).request.selector?.length)
    }
}
