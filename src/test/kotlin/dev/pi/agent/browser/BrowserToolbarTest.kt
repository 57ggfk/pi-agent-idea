package dev.pi.agent.browser

import java.awt.Component
import java.awt.Graphics
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JLabel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The browser toolbar's user-visible contract (048 走查后的工具条复检):
 *
 *  - icon-only nav buttons must stay compact (真机复检：每个按钮太宽，把地址栏
 *    挤没了);
 *  - the overflow menu (DevTools / system browser) must sit on the RIGHT edge,
 *    AFTER the Go button, not inside the nav icon cluster.
 *
 * The panel itself needs a Project and a JCEF browser, so the contract is
 * asserted on the extracted Swing-only helper.
 */
class BrowserToolbarTest {

    private fun stubIcon(size: Int): Icon = object : Icon {
        override fun getIconWidth(): Int = size
        override fun getIconHeight(): Int = size
        override fun paintIcon(c: Component?, g: Graphics?, x: Int, y: Int) = Unit
    }

    @Test
    fun `an icon-only nav button stays compact instead of stretching to the platform default width`() {
        val size = BrowserToolbar.compactButtonSize(stubIcon(16))
        assertEquals(24, size.width, "a 16px icon button must be 24px wide")
        assertEquals(24, size.height, "an icon-only button must stay square")
        assertTrue(size.width <= 30, "nav buttons must not stretch — got ${size.width}px")
    }

    @Test
    fun `the overflow menu sits on the right edge right after the Go button`() {
        val back = JButton("back")
        val forward = JButton("forward")
        val reload = JButton("reload")
        val address = JLabel("address")
        val go = JButton("Go")
        val overflow = JButton("more")

        val row = BrowserToolbar.buildNavRow(listOf(back, forward, reload), address, go, overflow)

        val right = row.rightCluster
        assertEquals(2, right.componentCount, "the right cluster holds Go + the overflow menu")
        assertTrue(right.getComponent(0) === go, "Go comes first")
        assertTrue(right.getComponent(1) === overflow, "the overflow menu follows Go")

        val nav = row.navCluster
        assertEquals(3, nav.componentCount, "the nav cluster keeps navigation only")
        assertTrue(nav.getComponent(0) === back)
        assertTrue(nav.getComponent(1) === forward)
        assertTrue(nav.getComponent(2) === reload)

        assertTrue(row.address === address, "the address bar absorbs the remaining width")
    }
}
