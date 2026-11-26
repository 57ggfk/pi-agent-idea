package dev.pi.agent.browser

import dev.pi.agent.PiAgentBundle
import org.cef.callback.CefContextMenuParams
import org.cef.callback.CefMenuModel
import java.lang.reflect.Proxy
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Proxy 缺省返回值：布尔 false / 整型 0 / 其余 null（与主代码 ABI 桥同款）。 */
private fun defaultReturn(method: java.lang.reflect.Method): Any? = when (method.returnType) {
    java.lang.Boolean.TYPE -> false
    java.lang.Integer.TYPE -> 0
    else -> null
}

/**
 * 066 变更 1：链接右键菜单从三项扩到四项——新增第 4 项「Open in Pi editor」，
 * 把链接 URL 在编辑器形态（LightVirtualFile 页签）打开。
 *
 * 回归红线（本文件存在的原因）：既有三项的 id、顺序与追加语义不得变动
 * （只加不减），且 handler 必须继续 APPEND 在分隔线之后——绝不能 clear /
 * remove 原生菜单项（F-211 真机事故回归锁）。
 *
 * CEF 接口用反射 Proxy 造假件（F-110 同款模式）：真接口随 JCEF 版本漂移，
 * 手写 fake 会在 243/144 双基线上脆断。
 */
class PiBrowserLinkMenuTest {

    /** 记录型 CefMenuModel：addItem 记 (id,label)，其余方法只记名字。 */
    private class RecordingMenu {
        val ops = mutableListOf<String>()
        val items = mutableListOf<Pair<Int, String>>()

        val model: CefMenuModel = Proxy.newProxyInstance(
            javaClass.classLoader,
            arrayOf(CefMenuModel::class.java),
        ) { _, method, args ->
            when (method.name) {
                "addSeparator" -> {
                    ops.add("addSeparator"); true
                }
                "addItem", "addCheckItem", "addRadioItem" -> {
                    val a = args ?: emptyArray<Any?>()
                    items.add((a[0] as Int) to (a[1] as String))
                    ops.add(method.name)
                    true
                }
                else -> defaultReturn(method)
            }
        } as CefMenuModel
    }

    private fun linkParams(url: String?): CefContextMenuParams =
        Proxy.newProxyInstance(
            javaClass.classLoader,
            arrayOf(CefContextMenuParams::class.java),
        ) { _, method, _ ->
            when (method.name) {
                "getLinkUrl" -> url
                else -> defaultReturn(method)
            }
        } as CefContextMenuParams

    // ---- 066 变更 1：第 4 项 ----

    @Test
    fun `link menu appends exactly four items after one separator`() {
        val menu = RecordingMenu()
        val handled = PiBrowserHandlers.appendLinkItems(menu.model, "https://example.com/page")

        assertTrue(handled, "a link URL must be handled by the plugin menu")
        assertEquals(
            listOf("addSeparator", "addItem", "addItem", "addItem", "addItem"),
            menu.ops,
            "menu shape: one separator, then the appended destinations",
        )
        val first = CefMenuModel.MenuId.MENU_ID_USER_FIRST
        // 070 审美修正：两个 Pi 目的地相邻——视觉顺序=system → embedded → editor → copy，
        // id 是固定槽位常量，调用顺序决定视觉顺序，故 id 序列不再是单调的 first..first+3。
        assertEquals(
            listOf(first, first + 1, first + 3, first + 2),
            menu.items.map { it.first },
            "visual order: system, embedded, editor, copy",
        )
        val labels = menu.items.map { it.second }
        assertEquals(4, labels.map { it.isNotBlank() }.count { it }, "every label must be non-blank")
        assertEquals(4, labels.toSet().size, "labels must be distinct destinations")
        assertEquals(
            listOf(
                PiAgentBundle.message("browser.link.option.SYSTEM_BROWSER"),
                PiAgentBundle.message("browser.link.option.EMBEDDED"),
                PiAgentBundle.message("browser.link.option.PI_EDITOR"),
                PiAgentBundle.message("browser.link.option.COPY"),
            ),
            labels,
            "the two Pi destinations must sit adjacent, copy last",
        )
    }

    @Test
    fun `link menu never clears or removes native items`() {
        val menu = RecordingMenu()
        PiBrowserHandlers.appendLinkItems(menu.model, "https://example.com/page")
        assertTrue(
            menu.ops.none { it.startsWith("remove") || it == "clear" || it == "removeAll" },
            "F-211: clearing the model deleted native items — must stay append-only",
        )
    }

    @Test
    fun `blank or missing link url adds nothing`() {
        for (url in listOf<String?>(null, "")) {
            val menu = RecordingMenu()
            val handled: Boolean = PiBrowserHandlers.appendLinkItems(menu.model, url ?: "")
            assertEquals(false, handled, "null/blank link URL must not be claimed")
            assertEquals(emptyList<String>(), menu.ops, "no menu mutation for a blank link")
            assertTrue(menu.items.isEmpty())
        }
    }
}
