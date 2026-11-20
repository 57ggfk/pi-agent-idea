package dev.pi.agent.browser

/**
 * The two shapes (carriers) a [BrowserPanel] can live in (054 变更 2):
 * a tool-window tab ([PiBrowserManager]) or an editor tab
 * ([PiBrowserEditorProvider]). The panel needs to know which one it is so
 * the overflow menu can grey out the "Open In" row for its own form.
 */
enum class BrowserCarrier {
    /** A tab inside the "Pi Agent" tool window (the 048 original form). */
    TOOLWINDOW,

    /** An editor tab backed by a LightVirtualFile (the 048 US9 D-track form). */
    EDITOR,
}

/**
 * Pure carrier-menu logic (054 变更 2). The overflow menu gains two "Open In"
 * rows — browser tab and editor tab — and the row for the panel's CURRENT
 * carrier is disabled: "switch to the form you are already in" must not be
 * offered as clickable. Pure so the disable rule is unit-testable without a
 * Project/JCEF (BrowserCarriersTest); the panel only translates
 * <target, enabled> into AnActions.
 */
object BrowserCarriers {

    /** One overflow-menu row: which carrier it switches to + whether it's clickable. */
    data class MenuItem(
        val target: BrowserCarrier,
        val enabled: Boolean,
    )

    /**
     * The two Open In rows for a panel whose current form is [carrier], in
     * display order (browser tab first, matching the 048 carrier introduction
     * order). Exactly one row is disabled — the current carrier's own.
     */
    fun menuItems(carrier: BrowserCarrier): List<MenuItem> =
        BrowserCarrier.entries.map { MenuItem(it, enabled = it != carrier) }

    /**
     * 054 agent dual-form (user-directed): the pi_browser `target` param →
     * carrier. Absent stays null — the caller falls back to the agent's
     * LAST-USED carrier so follow-up read/scroll/console reach the panel the
     * open landed on. Any other value is rejected by the codec before this
     * runs; mapping it to null keeps this function total.
     */
    fun carrierFor(target: String?): BrowserCarrier? = when (target) {
        "tab" -> BrowserCarrier.TOOLWINDOW
        "editor" -> BrowserCarrier.EDITOR
        else -> null
    }

    /**
     * 056 list 动作: the carrier's wire name in the LIST answer — the same
     * vocabulary as `target` (tab/editor) so the model can round-trip a LIST
     * result into a `target` param without a mapping table.
     */
    fun wireName(carrier: BrowserCarrier): String = when (carrier) {
        BrowserCarrier.TOOLWINDOW -> "tab"
        BrowserCarrier.EDITOR -> "editor"
    }
}
