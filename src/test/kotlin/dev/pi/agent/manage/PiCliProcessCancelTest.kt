package dev.pi.agent.manage

import dev.pi.agent.process.OsProcess
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Stopping an install has to work on a real process, not just in the abstract:
 * npm spawns node, and killing only the parent on Windows leaves a child that
 * keeps writing into the npm prefix. This runs an actual long-lived process,
 * stops it exactly the way `PiEnvironment.cancelInstall` does, and insists that
 * the waiting thread returns promptly — an install that cannot be stopped is
 * indistinguishable from a frozen IDE.
 */
class PiCliProcessCancelTest {

    @Test
    fun `a running process is stopped together with its descendants`() {
        // Deterministic and offline: neither variant needs a network or a package.
        val command = if (OsProcess.isWindows) {
            listOf(OsProcess.windowsShell, "/d", "/c", "ping", "-n", "60", "127.0.0.1")
        } else {
            listOf("sleep", "60")
        }
        val pb = ProcessBuilder(command).redirectErrorStream(true)
        val captured = AtomicReference<Process?>()
        val result = AtomicReference<CliResult?>()

        val worker = Thread {
            result.set(PiCliRunner.runProcessUntilExit(pb) { proc -> captured.set(proc) })
        }.apply { isDaemon = true; start() }

        // Wait for the process to actually exist before stopping it.
        val deadline = System.currentTimeMillis() + 10_000
        while (captured.get() == null && System.currentTimeMillis() < deadline) Thread.sleep(20)
        val proc = assertNotNull(captured.get(), "process never started")

        // Windows only: `cmd /d /c ping` spawns ping a beat after cmd starts,
        // and a kill that lands before that leaves ping alive holding the
        // inherited pipe — the stdout drain stays blocked past its join and
        // ThreadLeakTracker (rightly) reports the leak. Wait until the tree
        // actually has a descendant; unix `sleep 60` has none by design.
        if (OsProcess.isWindows) {
            val treeDeadline = System.currentTimeMillis() + 10_000
            while (System.currentTimeMillis() < treeDeadline) {
                if (proc.toHandle().descendants().findFirst().isPresent) break
                Thread.sleep(20)
            }
        }

        // Same sequence as PiEnvironment.cancelInstall.
        runCatching { proc.toHandle().descendants().forEach { it.destroyForcibly() } }
        proc.destroyForcibly()

        worker.join(15_000)
        assertFalse(worker.isAlive, "the waiting thread never returned after the process was killed")
        assertFalse(result.get()!!.success, "a killed process must not report success")
    }
}
