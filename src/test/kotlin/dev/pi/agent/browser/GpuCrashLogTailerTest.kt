package dev.pi.agent.browser

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 052: the log tailer must only ever report what Chromium wrote since the
 * last poll — a crash from a previous IDE run (or from before the watch
 * started) is history, not the current problem.
 */
class GpuCrashLogTailerTest {

    private fun tempDir(): File = Files.createTempDirectory("pi-gpu-tail").toFile()

    private fun crashLine(): String =
        "[15148:19552:1120/221643.406:ERROR:content\\browser\\gpu\\gpu_process_host.cc:1004] " +
            "GPU process exited unexpectedly: exit_code=-1"

    @Test
    fun `history is never replayed when the file is seen for the first time`() {
        val dir = tempDir()
        val log = File(dir, "jcef_chromium_4242.log")
        log.writeText(crashLine() + "\n")

        val tailer = GpuCrashLogTailer(listOf(dir), pid = 4242)
        assertTrue(tailer.newGpuCrashLines(nowMs = 1_000L).isEmpty())
    }

    @Test
    fun `a crash written after the first poll is reported once`() {
        val dir = tempDir()
        val log = File(dir, "jcef_chromium_4242.log")
        log.writeText("")

        val tailer = GpuCrashLogTailer(listOf(dir), pid = 4242)
        assertTrue(tailer.newGpuCrashLines(nowMs = 1_000L).isEmpty())

        log.appendText(crashLine() + "\n")
        assertEquals(1, tailer.newGpuCrashLines(nowMs = 2_000L).size)

        // the same line must not be counted twice
        assertTrue(tailer.newGpuCrashLines(nowMs = 3_000L).isEmpty())
    }

    @Test
    fun `a line split across two polls is counted once it is complete`() {
        val dir = tempDir()
        val log = File(dir, "jcef_chromium_4242.log")
        log.writeText("")

        val tailer = GpuCrashLogTailer(listOf(dir), pid = 4242)
        tailer.newGpuCrashLines(nowMs = 1_000L)

        log.appendText("GPU process exited unex")
        assertTrue(tailer.newGpuCrashLines(nowMs = 2_000L).isEmpty())

        log.appendText("pectedly: exit_code=-1\n")
        assertEquals(1, tailer.newGpuCrashLines(nowMs = 3_000L).size)
    }

    @Test
    fun `logs of other ide runs are ignored`() {
        val dir = tempDir()
        File(dir, "jcef_chromium_111.log").writeText(crashLine() + "\n")

        val tailer = GpuCrashLogTailer(listOf(dir), pid = 4242)
        assertTrue(tailer.newGpuCrashLines(nowMs = 1_000L).isEmpty())
    }
}
