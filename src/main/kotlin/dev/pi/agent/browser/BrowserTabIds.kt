package dev.pi.agent.browser

/**
 * 068 页签寻址: the agent-facing identity of a browser panel. The manager
 * stamps every live panel with a stable short id — tool-window tabs are
 * `t<n>`, editor previews are `e<n>` — so the model can address ONE tab
 * instead of "the selected one" (manual tab switching used to redirect the
 * agent's follow-ups to the wrong page).
 *
 * Ids live where the panel lives (no resident registry to go stale):
 * tool-window ids in the Content's userData, editor ids on the preview's
 * LightVirtualFile userData. Resolution = scan the live panels and match.
 */
object BrowserTabIds {

    /** Wire format: `t`/`e` + a positive integer (no leading zero). */
    const val PATTERN = "^[te][1-9][0-9]*$"

    val REGEX: Regex = Regex(PATTERN)

    /** Format check only; an id that looks right but names no live panel is a runtime miss. */
    fun isValid(id: String): Boolean = REGEX.matches(id)

    fun format(carrier: BrowserCarrier, n: Int): String =
        (if (carrier == BrowserCarrier.TOOLWINDOW) "t" else "e") + n.toString()
}

/**
 * Per-manager monotonic id sequence — ids are never reused, so a closed
 * tab's address stays dead (an old `tab:"t1"` can never silently hit a
 * recycled panel). ONE counter for both carriers: the number marks the
 * manager's lifetime, the prefix marks the carrier.
 */
internal class BrowserTabIdSequence {
    private val counter = java.util.concurrent.atomic.AtomicInteger()

    fun next(carrier: BrowserCarrier): String = BrowserTabIds.format(carrier, counter.incrementAndGet())
}

/**
 * One live browser panel with the identity the agent addresses it by.
 * [url]/[title] come from the kernel's last-known values (never a live CEF
 * query — LIST is answerable even while the page is mid-load).
 */
data class BrowserTabRef(
    val tabId: String,
    val panel: BrowserPanel,
    val carrier: BrowserCarrier,
    val selected: Boolean,
) {
    val url: String get() = panel.agentKernel().lastKnownUrl
    val title: String get() = panel.agentKernel().lastKnownTitle

    fun toSummary(): BrowserTabSummary =
        BrowserTabSummary(tabId, url, title, BrowserCarriers.wireName(carrier), selected)
}

/** LIST wire shape: `{tab,url,title,carrier,selected}` (field order unit-locked). */
data class BrowserTabSummary(
    val tabId: String,
    val url: String,
    val title: String,
    val carrier: String,
    val selected: Boolean,
)
