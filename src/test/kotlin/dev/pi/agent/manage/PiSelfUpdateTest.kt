package dev.pi.agent.manage

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The npm fallback for pi's self-update (issue #5).
 *
 * The fallback exists because pi refuses to update itself when it cannot
 * recognise the installation as package-managed — which happens when the npm
 * on PATH and the npm that installed pi have different prefixes. The fallback
 * has to install into the prefix pi actually lives in, and it must not
 * hijack failures that npm cannot fix.
 */
class PiSelfUpdateTest {

    /**
     * A fake npm install: the shim sits next to the global node_modules, the
     * package directory one level down.
     */
    private fun fakeNpmInstall(): File {
        val prefix = Files.createTempDirectory("pi-self-update").toFile()
        File(prefix, "pi.cmd").writeText("@echo off\r\n")
        File(prefix, "node_modules/@earendil-works/pi-coding-agent").mkdirs()
        return prefix
    }

    @Test
    fun `pi's refusal is recognised as the fallback case`() {
        assertTrue(
            PiSelfUpdate.isSelfUpdateRefusal(
                "error: pi cannot self-update this installation.\n" +
                    "Update @earendil-works/pi-coding-agent@1.6.1 using the package manager",
            ),
        )
    }

    @Test
    fun `other failures are not treated as the refusal`() {
        assertFalse(PiSelfUpdate.isSelfUpdateRefusal("npm error code EACCES: permission denied"))
        assertFalse(PiSelfUpdate.isSelfUpdateRefusal(""))
        assertFalse(
            PiSelfUpdate.isSelfUpdateRefusal(
                "error: pi self-update on Windows is only supported for npm and pnpm installs.",
            ),
        )
    }

    @Test
    fun `the prefix is derived from the pi path itself`() {
        val prefix = fakeNpmInstall()
        try {
            val shim = File(prefix, "pi.cmd").absolutePath
            assertEquals(prefix.absolutePath, PiSelfUpdate.prefixFor(shim))
        } finally {
            prefix.deleteRecursively()
        }
    }

    @Test
    fun `a layout without a global node_modules has no prefix to fall back to`() {
        val dir = Files.createTempDirectory("pi-self-update-plain").toFile()
        try {
            val plain = File(dir, "pi")
            plain.writeText("#!/bin/sh\n")
            assertNull(PiSelfUpdate.prefixFor(plain.absolutePath))
            assertNull(PiSelfUpdate.prefixFor(null))
            assertNull(PiSelfUpdate.prefixFor(""))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `the install command pins the prefix pi lives in`() {
        val args = PiSelfUpdate.npmInstallArgs("npm", "C:/npm-prefix")
        assertEquals(
            listOf("npm", "install", "-g", "--prefix", "C:/npm-prefix", "@earendil-works/pi-coding-agent@latest"),
            args,
        )
    }

    @Test
    fun `the npm that owns the installation wins over the one on PATH`() {
        val prefix = fakeNpmInstall()
        try {
            val shim = File(prefix, "pi.cmd").absolutePath
            val expectedRoot = File(prefix, "node_modules").absolutePath
            val owner = "C:/owner/npm.cmd"
            val stranger = "C:/stranger/npm.cmd"

            val chosen = PiSelfUpdate.npmFor(
                piPath = shim,
                candidates = { listOf(stranger, owner) },
                globalRootOf = { npm ->
                    if (npm == owner) expectedRoot else "C:/stranger/node_modules"
                },
            )

            assertEquals(owner, chosen, "the npm whose root holds pi must win")
        } finally {
            prefix.deleteRecursively()
        }
    }

    @Test
    fun `a stranger npm is used when no candidate claims the installation`() {
        val prefix = fakeNpmInstall()
        try {
            val shim = File(prefix, "pi.cmd").absolutePath
            val stranger = "C:/stranger/npm.cmd"
            val chosen = PiSelfUpdate.npmFor(
                piPath = shim,
                candidates = { listOf(stranger) },
                globalRootOf = { "C:/stranger/node_modules" },
            )
            assertEquals(stranger, chosen)
        } finally {
            prefix.deleteRecursively()
        }
    }

    @Test
    fun `no npm means no fallback at all`() {
        val prefix = fakeNpmInstall()
        try {
            val shim = File(prefix, "pi.cmd").absolutePath
            assertNull(
                PiSelfUpdate.npmFor(piPath = shim, candidates = { emptyList() }, globalRootOf = { null }),
            )
        } finally {
            prefix.deleteRecursively()
        }
    }

    @Test
    fun `the fallback runs the install command and reports its result`() {
        val prefix = fakeNpmInstall()
        try {
            val shim = File(prefix, "pi.cmd").absolutePath
            var ran: List<String>? = null
            val result = PiSelfUpdate.npmUpdate(
                piPath = shim,
                npmCandidates = { listOf("C:/npm/npm.cmd") },
                globalRootOf = { File(prefix, "node_modules").absolutePath },
                runner = { args, _ ->
                    ran = args
                    CliResult(0, "added 1 package", "")
                },
            )

            assertNotNull(result)
            assertTrue(result!!.success)
            assertEquals(
                listOf(
                    "C:/npm/npm.cmd",
                    "install",
                    "-g",
                    "--prefix",
                    prefix.absolutePath,
                    "@earendil-works/pi-coding-agent@latest",
                ),
                ran,
            )
        } finally {
            prefix.deleteRecursively()
        }
    }

    @Test
    fun `without a prefix there is no fallback to run`() {
        val dir = Files.createTempDirectory("pi-self-update-none").toFile()
        try {
            val plain = File(dir, "pi")
            plain.writeText("#!/bin/sh\n")
            var ran = false
            val result = PiSelfUpdate.npmUpdate(
                piPath = plain.absolutePath,
                npmCandidates = { listOf("C:/npm/npm.cmd") },
                globalRootOf = { null },
                runner = { _, _ ->
                    ran = true
                    CliResult(0, "", "")
                },
            )
            assertNull(result, "a layout without a prefix must not run an install")
            assertFalse(ran)
        } finally {
            dir.deleteRecursively()
        }
    }
}
