package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.EnumSource
import kotlin.test.Test

/**
 * Spec 060 T013: the three-state external-link setting. The default state
 * (SYSTEM) must keep 037 semantics byte-for-byte — that is the regression
 * promise this file exists to lock.
 */
class LinkRoutingTest {

    @Test
    fun `loopback urls never leave the chat panel regardless of setting`() {
        val urls = listOf(
            "http://127.0.0.1:57707/?token=x",
            "http://localhost:8080/webui/app.js",
            "http://localhost/",
        )
        for (target in LinkTarget.entries) {
            for (url in urls) {
                assertEquals(LinkRoute.CefDefault, LinkRouting.routeExternalLink(url, target), "$target $url")
            }
        }
    }

    @Test
    fun `blank urls stay with cef`() {
        for (target in LinkTarget.entries) {
            assertEquals(LinkRoute.CefDefault, LinkRouting.routeExternalLink(null, target))
            assertEquals(LinkRoute.CefDefault, LinkRouting.routeExternalLink("", target))
        }
    }

    @Test
    fun `external urls follow the setting`() {
        val url = "https://marketplace.example.com/pkg"
        assertEquals(LinkRoute.SystemBrowser, LinkRouting.routeExternalLink(url, LinkTarget.SYSTEM))
        assertEquals(LinkRoute.Embedded, LinkRouting.routeExternalLink(url, LinkTarget.EMBEDDED))
        assertEquals(LinkRoute.AskUser, LinkRouting.routeExternalLink(url, LinkTarget.ASK))
    }

    @Test
    fun `https loopback variant is still loopback`() {
        // The SPA is served over plain loopback HTTP; https on 127.0.0.1 is a
        // real external page and must follow the setting.
        assertTrue(LinkRouting.routeExternalLink("https://127.0.0.1/x", LinkTarget.SYSTEM) == LinkRoute.SystemBrowser)
        assertFalse(LinkRouting.isLoopback("https://localhost:8080"))
    }

    // ---- 061 A1: ask-mode selector options ----

    @Test
    fun `selector offers exactly three options in spec Q3 order`() {
        assertEquals(
            listOf(LinkOption.SYSTEM_BROWSER, LinkOption.EMBEDDED, LinkOption.COPY),
            LinkRouting.linkOptions(),
        )
    }

    @Test
    fun `option labels resolve from the bundle`() {
        // Smoke: every option's label key exists and is non-empty (i18n pair
        // completeness is asserted by the bundle grep in A2).
        for (option in LinkOption.entries) {
            assertTrue(option.label().isNotBlank(), option.name)
        }
    }

    @Test
    fun `ask decision still routes through AskUser unchanged`() {
        // The selector changes the ASK execution, not the decision — this
        // locks the decision side so the popup wiring cannot shift routing.
        assertEquals(LinkRoute.AskUser, LinkRouting.routeExternalLink("https://example.com/page", LinkTarget.ASK))
    }

    // ---- 061 origin-aware routing (dev-server links must not be swallowed) ----

    private val own = "http://127.0.0.1:53451"

    @Test
    fun `spa origin stays in the chat regardless of setting`() {
        val urls = listOf(
            "http://127.0.0.1:53451/?token=x&instance=1",
            "http://127.0.0.1:53451/bridge/poll",
            "http://127.0.0.1:53451",
        )
        for (target in LinkTarget.entries) {
            for (url in urls) {
                assertEquals(LinkRoute.CefDefault, LinkRouting.routeExternalLink(url, target, own), "$target $url")
            }
        }
    }

    @Test
    fun `dev server loopback on another port follows the setting`() {
        // 061 真机缺陷回归: host-only loopback 检查把 AI 分享的本地服务链接
        // (http://127.0.0.1:8931/…) 误判为 SPA，其 target=_blank popup 裸开成白窗。
        val url = "http://127.0.0.1:8931/probe-browser.html"
        assertEquals(LinkRoute.SystemBrowser, LinkRouting.routeExternalLink(url, LinkTarget.SYSTEM, own))
        assertEquals(LinkRoute.Embedded, LinkRouting.routeExternalLink(url, LinkTarget.EMBEDDED, own))
        assertEquals(LinkRoute.AskUser, LinkRouting.routeExternalLink(url, LinkTarget.ASK, own))
    }

    @Test
    fun `own origin match is port exact`() {
        // Prefix must not leak across ports: :5345 is a different origin than :53451.
        assertTrue(LinkRouting.isOwnOrigin("http://127.0.0.1:53451/x", own))
        assertFalse(LinkRouting.isOwnOrigin("http://127.0.0.1:5345/x", own))
        assertFalse(LinkRouting.isOwnOrigin("http://127.0.0.1:534512/x", own))
        assertFalse(LinkRouting.isOwnOrigin("http://localhost:53451/x", own))
    }

    @Test
    fun `origin overload without origin falls back to legacy loopback rule`() {
        assertEquals(LinkRoute.CefDefault, LinkRouting.routeExternalLink("http://127.0.0.1:8931/x", LinkTarget.SYSTEM, null))
        assertEquals(LinkRoute.SystemBrowser, LinkRouting.routeExternalLink("https://example.com/", LinkTarget.SYSTEM, null))
    }
}
