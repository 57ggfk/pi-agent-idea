package dev.pi.agent.browser

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 052: the GPU-crash detector is pure logic on purpose. The platform hook we
 * would have used does not exist on the supported line (233-263) and the CEF
 * app-handler slot belongs to the platform, so the plugin counts Chromium GPU
 * process launches itself.
 */
class GpuCrashPolicyTest {

    @Test
    fun `a gpu process command line is recognized`() {
        assertTrue(
            GpuCrashPolicy.isGpuProcess(
                "\"C:\\IDE\\jcef\\cef_server.exe\" --type=gpu-process --no-sandbox",
            ),
        )
    }

    @Test
    fun `other child processes are not gpu processes`() {
        assertFalse(GpuCrashPolicy.isGpuProcess("\"cef_server.exe\" --type=renderer"))
        assertFalse(GpuCrashPolicy.isGpuProcess("\"cef_server.exe\" --type=utility --utility-sub-type=network"))
        assertFalse(GpuCrashPolicy.isGpuProcess("\"cef_server.exe\" --port=30000"))
        assertFalse(GpuCrashPolicy.isGpuProcess(""))
        assertFalse(GpuCrashPolicy.isGpuProcess(null))
    }

    @Test
    fun `fewer launches than the threshold do not warn`() {
        assertEquals(
            GpuCrashDecision.NONE,
            GpuCrashPolicy.decide(listOf(0L, 10_000L), nowMs = 10_000L),
        )
    }

    @Test
    fun `the threshold warns`() {
        assertEquals(
            GpuCrashDecision.NOTIFY,
            GpuCrashPolicy.decide(listOf(0L, 20_000L, 40_000L), nowMs = 60_000L),
        )
    }

    @Test
    fun `launches older than the window do not count`() {
        // 0 / 10s / 20s are all older than the 60s window at t=120s.
        assertEquals(
            GpuCrashDecision.NONE,
            GpuCrashPolicy.decide(listOf(0L, 10_000L, 20_000L), nowMs = 120_000L),
        )
    }

    @Test
    fun `launches inside the window count even when older ones exist`() {
        val now = 120_000L
        assertEquals(
            GpuCrashDecision.NOTIFY,
            GpuCrashPolicy.decide(listOf(0L, 90_000L, 100_000L, 110_000L), nowMs = now),
        )
    }

    @Test
    fun `only gpu processes count as launches`() {
        val samples = listOf(
            11L to "\"cef_server.exe\" --type=gpu-process",
            12L to "\"cef_server.exe\" --type=renderer",
            13L to "\"cef_server.exe\" --type=utility",
        )
        assertEquals(setOf(11L), GpuProcessScanner.gpuPids(samples))
    }
}
