package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.EnumSource
import kotlin.test.Test

/**
 * Spec 048 T013: the three-state external-link setting. The default state
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
}
