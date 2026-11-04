package dev.pi.agent.process

import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PiLocatorTest {

    private val isWindows: Boolean =
        System.getProperty("os.name")?.lowercase()?.contains("windows") == true

    private val realPi: String? = PiLocator.locate(forceRefresh = true)?.path

    @Test
    fun `spawns node scripts through their interpreter`() {
        val pi = realPi ?: return
        assumeTrue(PiLocator.isNodeScript(pi), "real pi is not a node script")
        val command = PiLocator.spawnCommand(pi, listOf("--version"))
        assertEquals(
            listOf(PiLocator.nodeInterpreterFor(pi), pi, "--version"),
            command,
            "node scripts must spawn as [node, pi, args…]",
        )
        assertTrue(File(command[0]).canExecute())
    }

    @Test
    fun `non-node scripts spawn directly`() {
        val dir = tempDir()
        val fake = File(dir, "notnode").apply {
            writeText("#!/bin/sh\necho hi\n")
            setExecutable(true)
        }
        val command = PiLocator.spawnCommand(fake.absolutePath, listOf("--version"))
        assertEquals(listOf(fake.absolutePath, "--version"), command)
        dir.deleteRecursively()
    }

    @Test
    fun `node bin dir resolves next to nvm installs`() {
        val pi = realPi ?: return
        assumeTrue(PiLocator.isNodeScript(pi), "real pi is not a node script")
        val binDir = PiLocator.nodeBinDirFor(pi)
        assumeTrue(binDir != null, "no node interpreter found for $pi")
        val nodeBinary = if (isWindows) "node.exe" else "node"
        assertTrue(File(binDir!!, nodeBinary).canExecute())
    }

    @Test
    fun `cmd shims are wrapped in cmd c on windows`() {
        assumeTrue(isWindows, "Windows-only behaviour")
        val shim = "C:\\Users\\dev\\AppData\\Roaming\\npm\\pi.cmd"
        assertTrue(OsProcess.isCmdLike(shim))
        assertEquals(
            // An absolute interpreter, never the bare name `cmd`: a bare name
            // is resolved against the IDE process's own PATH and can land on
            // a non-executable file (CreateProcess error=193). `/d` keeps the
            // AutoRun hook out of the child's PATH.
            listOf(OsProcess.windowsShell, "/d", "/c", shim, "--version"),
            OsProcess.launchCommand(listOf(shim, "--version")),
        )
        assertTrue(File(OsProcess.windowsShell).isAbsolute)
        assertFalse(OsProcess.isCmdLike("C:\\Program Files\\nodejs\\node.exe"))
    }

    @Test
    fun `non-cmd commands pass through launchCommand`() {
        assertEquals(
            listOf("node", "--version"),
            OsProcess.launchCommand(listOf("node", "--version")),
        )
    }

    @Test
    fun `windows script detection is by extension`() {
        assumeTrue(isWindows, "Windows-only behaviour")
        val dir = tempDir()
        assertTrue(
            PiLocator.isNodeScript(File(dir, "mock.mjs").apply { writeText("export {}") }.absolutePath),
            ".mjs must be treated as a node script",
        )
        assertFalse(
            PiLocator.isNodeScript(File(dir, "pi.cmd").apply { writeText("@echo off") }.absolutePath),
            ".cmd shims resolve node themselves",
        )
        dir.deleteRecursively()
    }

    private fun tempDir(): File =
        File(System.getProperty("java.io.tmpdir"), "pi-locator-test-${System.nanoTime()}").apply { mkdirs() }
}
