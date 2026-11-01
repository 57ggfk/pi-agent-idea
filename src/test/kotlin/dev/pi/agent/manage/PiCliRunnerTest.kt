package dev.pi.agent.manage

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Exercises PiCliRunner.runProcess directly (bypassing pi discovery) with
 * real child processes, in particular the pipe-buffer deadlock scenario that
 * motivated the concurrent drain. Commands have per-OS equivalents: Unix uses
 * /bin/sh, Windows uses PowerShell/cmd (no POSIX tools there).
 */
class PiCliRunnerTest {

    private val isWindows: Boolean =
        System.getProperty("os.name")?.lowercase()?.contains("windows") == true

    private fun proc(unix: String, windows: List<String>): ProcessBuilder =
        if (isWindows) ProcessBuilder(windows) else ProcessBuilder("/bin/sh", "-c", unix)

    @Test
    fun `stdout larger than pipe buffer does not deadlock`() {
        // 200KB of stdout far exceeds the ~64KB pipe buffer; waiting before
        // draining would hang until the timeout and misreport a failure.
        val result = PiCliRunner.runProcess(
            proc(
                "yes hello | head -c 200000",
                listOf("powershell", "-NoProfile", "-Command", "1..60000 | ForEach-Object { 'hello' }"),
            ),
            timeoutSeconds = 20,
        )
        assertTrue(result.success, "stderr: ${result.stderr}")
        assertEquals(0, result.exitCode)
        // forEachLine re-terminates the final partial line, so ±1 byte.
        assertTrue(result.stdout.length >= 200_000, "stdout length: ${result.stdout.length}")
        assertTrue(result.stdout.startsWith("hello"))
    }

    @Test
    fun `stderr larger than pipe buffer does not deadlock`() {
        val result = PiCliRunner.runProcess(
            proc(
                "yes err | head -c 200000 1>&2",
                listOf(
                    "powershell", "-NoProfile", "-Command",
                    "1..60000 | ForEach-Object { [Console]::Error.WriteLine('err') }",
                ),
            ),
            timeoutSeconds = 20,
        )
        assertTrue(result.success, "stderr: ${result.stderr}")
        assertTrue(result.stderr.length >= 200_000, "stderr length: ${result.stderr.length}")
    }

    @Test
    fun `timeout reports error and partial stdout`() {
        val start = System.currentTimeMillis()
        // PowerShell is a single child process, so destroyForcibly also ends
        // it — cmd would leave the ping grandchild holding the stdout pipe
        // open and the drain thread alive past the test.
        val result = PiCliRunner.runProcess(
            proc(
                "echo partial; sleep 30",
                listOf("powershell", "-NoProfile", "-Command", "'partial'; Start-Sleep -Seconds 30"),
            ),
            timeoutSeconds = 1,
        )
        assertFalse(result.success)
        assertTrue(result.stderr.contains("timed out after 1s"))
        assertTrue(result.stdout.contains("partial"), "partial stdout should be captured")
        // Must return near the timeout, not after 30s.
        assertTrue(System.currentTimeMillis() - start < 10_000, "runProcess should return promptly on timeout")
    }

    @Test
    fun `nonzero exit propagates`() {
        val result = PiCliRunner.runProcess(
            proc(
                "echo boom 1>&2; exit 3",
                listOf("cmd", "/c", "echo boom 1>&2 & exit 3"),
            ),
            timeoutSeconds = 10,
        )
        assertEquals(3, result.exitCode)
        assertFalse(result.success)
        assertTrue(result.stderr.contains("boom"))
    }
}
