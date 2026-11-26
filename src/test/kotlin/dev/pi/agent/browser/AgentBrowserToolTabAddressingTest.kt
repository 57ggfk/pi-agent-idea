package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * 068 页签寻址: the panel resolution order behind every pi_browser action —
 * explicit `tab` id (miss = model-readable failure) → the tab the last open
 * landed on ([PiBrowserManager.lastTabId]) → the 067 carrier fallback
 * (lastAgentCarrier / selected tab). Pure over lambdas so no Project/JCEF is
 * needed; the tool wires the lambdas to the manager. `P` is the panel type —
 * the test uses strings, production passes [BrowserPanel].
 */
class AgentBrowserToolTabAddressingTest {

    /** Stand-in live panels: id → panel handle (t* = tool window, e* = editor). */
    private val live = mapOf("t1" to "panel-t1", "t2" to "panel-t2", "e1" to "panel-e1")

    private fun resolve(
        explicitTab: String?,
        lastTabId: String?,
        target: String? = null,
    ): AgentBrowserTool.PanelLookup<String> = AgentBrowserTool.resolveAgentPanel(
        explicitTab = explicitTab,
        lastTabId = lastTabId,
        carrier = BrowserCarriers.carrierFor(target) ?: BrowserCarrier.TOOLWINDOW,
        panelById = { id: String -> live[id] },
        panelForCarrier = { carrier: BrowserCarrier ->
            when (carrier) {
                BrowserCarrier.TOOLWINDOW -> "panel-t1"
                BrowserCarrier.EDITOR -> "panel-e1"
            }
        },
        tabIdOf = { panel: String -> live.entries.firstOrNull { it.value == panel }?.key },
    )

    @Test
    fun `explicit tab resolves by id and stamps that id`() {
        val lookup = resolve(explicitTab = "t2", lastTabId = null)
        assertEquals("panel-t2", lookup.panel)
        assertEquals("t2", lookup.tabId)
    }

    @Test
    fun `explicit unknown tab is a model-readable miss naming the id`() {
        val lookup = resolve(explicitTab = "t9", lastTabId = null)
        assertNull(lookup.panel)
        assertTrue(
            "no browser tab t9" in (lookup.missReason ?: ""),
            "reason=${lookup.missReason}",
        )
    }

    @Test
    fun `explicit tab wins over lastTabId and over target`() {
        // tab beats the last-open pointer...
        assertEquals("panel-t2", resolve(explicitTab = "t2", lastTabId = "t1").panel)
        // ...and beats the carrier form (target=editor would say panel-e1).
        assertEquals("panel-t1", resolve(explicitTab = "t1", lastTabId = null, target = "editor").panel)
    }

    @Test
    fun `no explicit tab follows the last opened tab before the carrier fallback`() {
        // 068's whole point: open landed on t2, the user then selected t1 —
        // follow-ups must still reach t2 (identity, not selection).
        val lookup = resolve(explicitTab = null, lastTabId = "t2")
        assertEquals("panel-t2", lookup.panel)
        assertEquals("t2", lookup.tabId)
    }

    @Test
    fun `stale lastTabId degrades to the 067 carrier fallback`() {
        // t3 was closed after the open (not in the live map): the follow-up
        // falls through to the carrier resolution (selected tool-window tab)
        // instead of failing.
        val lookup = resolve(explicitTab = null, lastTabId = "t3")
        assertEquals("panel-t1", lookup.panel)
        assertEquals("t1", lookup.tabId)
    }

    @Test
    fun `no tab memory at all resolves the carrier panel`() {
        val lookup = resolve(explicitTab = null, lastTabId = null, target = "editor")
        assertEquals("panel-e1", lookup.panel)
        assertEquals("e1", lookup.tabId, "the carrier-resolved panel still stamps its tab id")
    }

    @Test
    fun `no live panel anywhere misses with the 065 reason`() {
        val lookup = AgentBrowserTool.resolveAgentPanel<String>(
            explicitTab = null,
            lastTabId = null,
            carrier = BrowserCarrier.EDITOR,
            panelById = { null },
            panelForCarrier = { null },
            tabIdOf = { null },
        )
        assertNull(lookup.panel)
        assertEquals(AgentBrowserTool.NO_TAB_REASON, lookup.missReason)
    }
}
