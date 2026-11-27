package dev.pi.agent.process

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The on-disk pi version (issue #6).
 *
 * Two facts must hold: the answer is read without spawning a process when the
 * installation is an npm one (the package.json carries the version), and the
 * cache does not answer with a stale value once the installation changed.
 */
class PiDiskVersionTest {

    /**
     * A fake npm install: the shim sits next to the global node_modules, the
     * package.json one level down.
     */
    private fun fakeNpmInstall(version: String): Pair<File, File> {
        val prefix = Files.createTempDirectory("pi-disk-version").toFile()
        val shim = File(prefix, "pi.cmd")
        shim.writeText("@echo off\r\n")
        val pkgDir = File(prefix, "node_modules/@earendil-works/pi-coding-agent")
        pkgDir.mkdirs()
        val pkgJson = File(pkgDir, "package.json")
        pkgJson.writeText("""{"name":"@earendil-works/pi-coding-agent","version":"$version"}""")
        return prefix to pkgJson
    }

    @Test
    fun `the package json carries the version without a subprocess`() {
        val (prefix, _) = fakeNpmInstall("1.6.1")
        try {
            assertEquals("1.6.1", PiDiskVersion.packageJsonVersion(File(prefix, "pi.cmd").absolutePath))
        } finally {
            prefix.deleteRecursively()
        }
    }

    @Test
    fun `a non-npm layout has no package json to read`() {
        val dir = Files.createTempDirectory("pi-disk-version-plain").toFile()
        try {
            val plain = File(dir, "pi")
            plain.writeText("#!/bin/sh\n")
            assertNull(PiDiskVersion.packageJsonVersion(plain.absolutePath))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `the stamp changes when the installation changes`() {
        val (prefix, pkgJson) = fakeNpmInstall("1.6.1")
        try {
            val shim = File(prefix, "pi.cmd").absolutePath
            val before = PiDiskVersion.stampOf(shim)
            assertTrue(before.isNotEmpty(), "an npm install must produce a stamp")

            // An external upgrade rewrites the package.json — the fingerprint
            // has to notice, otherwise the cached version would be served
            // forever.
            Thread.sleep(1100)
            pkgJson.writeText("""{"name":"@earendil-works/pi-coding-agent","version":"1.6.2"}""")

            assertTrue(PiDiskVersion.stampOf(shim) != before, "the stamp must move when the install changes")
        } finally {
            prefix.deleteRecursively()
        }
    }

    @Test
    fun `the stamp is empty when the path is unknown`() {
        assertEquals("", PiDiskVersion.stampOf(null))
        assertEquals("", PiDiskVersion.stampOf(""))
    }

    @Test
    fun `the package json path is found next to the shim`() {
        val (prefix, pkgJson) = fakeNpmInstall("1.6.1")
        try {
            val found = PiDiskVersion.packageJsonFor(File(prefix, "pi.cmd").absolutePath)
            assertNotNull(found)
            assertEquals(pkgJson.absolutePath, found!!.absolutePath)
        } finally {
            prefix.deleteRecursively()
        }
    }
}
