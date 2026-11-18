package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
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
        for (body in listOf(null, "", "not json", "{}", """{"action":"delete"}""", """{"action":"open"}""")) {
            val parsed = AgentBrowserRequestCodec.parse(body)
            assertIs<AgentParseResult.Invalid>(parsed, "body=$body")
        }
    }

    @Test
    fun `open without url is rejected but read needs none`() {
        assertIs<AgentParseResult.Invalid>(AgentBrowserRequestCodec.parse("""{"action":"open","url":"  "}"""))
        assertIs<AgentParseResult.Valid>(AgentBrowserRequestCodec.parse("""{"action":"read","url":""}"""))
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
}
