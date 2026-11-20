package dev.pi.agent.browser

import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * The browser toolbar's layout contract (048 走查后的工具条复检).
 *
 * Two user-visible facts live here instead of inside the panel:
 *
 *  - an icon-only nav button must stay SQUARE. The platform's default
 *    button metrics stretch such a button to ~60px wide, and four of those
 *    pushed the address bar off the row (真机复检：每个按钮太宽).
 *  - the overflow menu (DevTools / system browser) sits on the RIGHT edge,
 *    AFTER the Go button — not inside the nav icon cluster.
 *
 * The helper is Swing-only (no Project, no JCEF), so both facts are unit
 * testable; the panel keeps the IDE wiring.
 */
internal class BrowserToolbarRow(
    /** The row itself — put it into the panel's NORTH. */
    val panel: JPanel,
    /** WEST cluster: navigation icons only. */
    val navCluster: JPanel,
    /** CENTER: the address bar. */
    val address: JComponent,
    /** EAST cluster: Go + the overflow menu, in that order. */
    val rightCluster: JPanel,
)

internal object BrowserToolbar {

    /**
     * Icon-only button box: the icon plus a small breathing margin. The icon
     * loader hands back already-scaled icons, so this stays HiDPI-correct.
     */
    fun compactButtonSize(icon: Icon): Dimension =
        Dimension(icon.iconWidth + 8, icon.iconHeight + 8)

    /**
     * WEST = nav icons, CENTER = address bar, EAST = (Go, overflow).
     */
    fun buildNavRow(
        navButtons: List<JButton>,
        address: JComponent,
        goButton: JButton,
        overflowButton: JButton,
    ): BrowserToolbarRow {
        val navRow = JPanel(BorderLayout())
        val navCluster = JPanel(FlowLayout(FlowLayout.LEFT, 2, 0))
        navButtons.forEach { navCluster.add(it) }
        navRow.add(navCluster, BorderLayout.WEST)
        navRow.add(address, BorderLayout.CENTER)
        val rightCluster = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0))
        rightCluster.add(goButton)
        rightCluster.add(overflowButton)
        navRow.add(rightCluster, BorderLayout.EAST)
        return BrowserToolbarRow(navRow, navCluster, address, rightCluster)
    }
}
