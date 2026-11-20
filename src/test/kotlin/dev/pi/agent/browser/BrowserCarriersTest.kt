package dev.pi.agent.browser

import com.intellij.openapi.project.Project
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 054 变更 2：overflow 菜单（Browser actions 弹窗）追加两种形态的 Open In
 * ——「Open in Pi browser tab」（工具窗页签）与「Open in Pi editor」（编辑器
 * 页签）。置灰规则：当前载体对应的 Open In 项 disabled——已经是这个形态，
 * 「切换过去」不该作为可点击项出现。
 *
 * 置灰判定抽成纯函数 [BrowserCarriers.menuItems]，无需 Project/JCEF 即可
 * 单测；面板只负责把 <item, enabled> 翻译成 AnAction。
 */
class BrowserCarriersTest {

    @Test
    fun `toolwindow panel offers the editor switch enabled and the tab switch disabled`() {
        val items = BrowserCarriers.menuItems(BrowserCarrier.TOOLWINDOW)

        assertEquals(
            listOf(BrowserCarrier.TOOLWINDOW, BrowserCarrier.EDITOR),
            items.map { it.target },
            "both destinations are offered, tab first (matches the overflow menu order)",
        )
        val byTarget = items.associateBy { it.target }
        assertFalse(byTarget.getValue(BrowserCarrier.TOOLWINDOW).enabled, "already a tool-window tab: switching to it is a no-op")
        assertTrue(byTarget.getValue(BrowserCarrier.EDITOR).enabled, "editor form is reachable from the tool window")
    }

    @Test
    fun `editor panel offers the tab switch enabled and the editor switch disabled`() {
        val items = BrowserCarriers.menuItems(BrowserCarrier.EDITOR)

        val byTarget = items.associateBy { it.target }
        assertTrue(byTarget.getValue(BrowserCarrier.TOOLWINDOW).enabled, "tool-window tab is reachable from the editor")
        assertFalse(byTarget.getValue(BrowserCarrier.EDITOR).enabled, "already an editor tab: switching to it is a no-op")
    }

    @Test
    fun `menu covers both carriers exactly once for every carrier`() {
        for (carrier in BrowserCarrier.entries) {
            val items = BrowserCarriers.menuItems(carrier)
            assertEquals(
                BrowserCarrier.entries,
                items.map { it.target }.sorted(),
                "$carrier must yield exactly one row per carrier",
            )
            assertEquals(
                1,
                items.count { !it.enabled },
                "exactly one row (the current carrier) is disabled",
            )
        }
    }

    /**
     * 载体接线锁：BrowserPanel 必须携带 carrier 构造参数——PiBrowserManager
     * 的页签传 TOOLWINDOW、PiBrowserEditorProvider 的编辑器传 EDITOR。
     * 面板构造需要真 Project，无法在单测里实例化，故锁在构造签名上。
     */
    @Test
    fun `browser panel takes the carrier as a constructor parameter`() {
        val withCarrier = BrowserPanel::class.java.constructors.filter {
            it.parameterTypes.contentEquals(arrayOf(Project::class.java, Boolean::class.javaPrimitiveType, BrowserCarrier::class.java))
        }
        assertEquals(1, withCarrier.size, "BrowserPanel(Project, boolean, BrowserCarrier) must exist")
    }

    /**
     * 054 agent 双形态：pi_browser 的 target 参数 → 载体映射（纯函数）。
     * 缺省保持 null——调用方回退到 agent 上次打开的载体；"tab"/"editor"
     * 之外编码层已拒绝，这里兜底为 null 保持全函数。
     */
    @Test
    fun `carrierFor maps the agent target param`() {
        assertEquals(BrowserCarrier.TOOLWINDOW, BrowserCarriers.carrierFor("tab"), "'tab' = tool-window tab")
        assertEquals(BrowserCarrier.EDITOR, BrowserCarriers.carrierFor("editor"), "'editor' = editor-form preview")
        assertNull(BrowserCarriers.carrierFor(null), "absent target falls back to the last-used carrier")
        assertNull(BrowserCarriers.carrierFor("window"), "values outside the codec set map to null")
    }
}
