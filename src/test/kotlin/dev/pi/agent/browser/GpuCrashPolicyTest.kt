package dev.pi.agent.browser

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 064: the GPU-crash detector is pure logic on purpose. The platform hook we
 * would have used does not exist on the supported line (233-263) and the CEF
 * app-handler slot belongs to the platform, so the plugin reads Chromium's
 * own crash log instead.
 */
class GpuCrashPolicyTest {

    @Test
    fun `a chromium gpu crash line is recognized`() {
        assertTrue(
            GpuCrashPolicy.isGpuCrashLine(
                "[35908:13356:1120/213859.337:ERROR:content\\browser\\gpu\\gpu_process_host.cc:1004] " +
                    "GPU process exited unexpectedly: exit_code=-1",
            ),
        )
    }

    @Test
    fun `the command buffer symptom is not counted as a crash`() {
        // "Failed to send GpuControl.CreateCommandBuffer" fires many times per
        // crash (240 lines for 385 crashes in the 061 log) — counting it would
        // inflate the number and fire on a single crash.
        assertFalse(
            GpuCrashPolicy.isGpuCrashLine(
                "ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer.",
            ),
        )
    }

    @Test
    fun `unrelated chromium lines are not gpu crashes`() {
        assertFalse(
            GpuCrashPolicy.isGpuCrashLine(
                "[18392:42872:1120/213757.313:VERBOSE1:net\\base\\network_delegate.cc:38] " +
                    "NetworkDelegate::NotifyBeforeURLRequest: http://127.0.0.1:52817/bridge/poll",
            ),
        )
        assertFalse(GpuCrashPolicy.isGpuCrashLine("Histogram: GPU.ANGLE.D3D11FeatureLevel recorded 1 samples, mean = 5.0"))
        assertFalse(GpuCrashPolicy.isGpuCrashLine(""))
    }

    @Test
    fun `only crash lines are counted`() {
        val lines = listOf(
            "GPU process exited unexpectedly: exit_code=-1",
            "something else",
            "Failed to send GpuControl.CreateCommandBuffer",
        )
        assertEquals(1, GpuCrashPolicy.countGpuCrashLines(lines))
    }

    @Test
    fun `fewer crashes than the threshold do not warn`() {
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
    fun `crashes older than the window do not count`() {
        assertEquals(
            GpuCrashDecision.NONE,
            GpuCrashPolicy.decide(listOf(0L, 10_000L, 20_000L), nowMs = 120_000L),
        )
    }

    @Test
    fun `crashes inside the window count even when older ones exist`() {
        assertEquals(
            GpuCrashDecision.NOTIFY,
            GpuCrashPolicy.decide(listOf(0L, 90_000L, 100_000L, 110_000L), nowMs = 120_000L),
        )
    }

    @Test
    fun `only the log of this ide run is watched`() {
        val now = 1_000_000L
        val candidates = listOf(
            GpuCrashLogFiles.Candidate("jcef_chromium_4242.log", now - 5_000),
            GpuCrashLogFiles.Candidate("jcef_4242.log", now - 5_000),
            GpuCrashLogFiles.Candidate("jcef_chromium_111.log", now - 86_400_000),
            GpuCrashLogFiles.Candidate("idea.log", now - 1_000),
        )
        val picked = GpuCrashLogFiles.select(candidates, pid = 4242, nowMs = now)
        assertEquals(setOf("jcef_chromium_4242.log", "jcef_4242.log"), picked.map { it.name }.toSet())
    }
}
