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
}
