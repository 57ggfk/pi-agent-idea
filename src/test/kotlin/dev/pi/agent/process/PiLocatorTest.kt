package dev.pi.agent.process

import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PiLocatorTest {

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
        val dir = Files_createTempDir()
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
        assertTrue(File(binDir!!, "node").canExecute())
    }

    private fun Files_createTempDir(): File =
        File(System.getProperty("java.io.tmpdir"), "pi-locator-test-${System.nanoTime()}").apply { mkdirs() }
}
