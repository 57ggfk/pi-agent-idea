package dev.pi.agent.bridge

import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 真机审查 P1-1：粘贴临时文件必须落在**短路径**上——macOS 的系统临时目录
 * 前缀就有 52 个字符，引用路径会撑到 105 字符、在输入框里折成三行。
 */
class PasteTempStoreTest {

    @Test
    fun `root sits under the user home and keeps the pi-paste marker`() {
        val root = PasteTempStore.root("/Users/tester")
        assertEquals("/Users/tester/.pi-agent/pi-paste", root.toString())
        // The frontend recognises temp references by this marker (044 FR-014).
        assertTrue(root.toString().contains("pi-paste"))
    }

    @Test
    fun `the reference path stays short enough for one composer line`() {
        val root = PasteTempStore.root("/Users/tester")
        val name = PasteTempStore.fileName(PasteTempStore.newTag(), 1)
        val reference = "@${root.resolve(name)}"
        // 402px composer ≈ 51 monospace chars; the macOS temp root alone was 52.
        assertTrue(reference.length <= 60, "reference too long: $reference")
    }

    @Test
    fun `file names are unique per tag and carry the sequence`() {
        assertEquals("a3f9c2-1.txt", PasteTempStore.fileName("a3f9c2", 1))
        assertEquals("a3f9c2-12.txt", PasteTempStore.fileName("a3f9c2", 12))
        assertTrue(PasteTempStore.newTag() != PasteTempStore.newTag())
    }

    @Test
    fun `ensureRoot creates a private directory`() {
        val home = Files.createTempDirectory("paste-store-home-")
        try {
            val root = PasteTempStore.ensureRoot(home.toString())
            assertTrue(Files.isDirectory(root))
            val perms = Files.getPosixFilePermissions(root)
            assertEquals(
                setOf(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE,
                    PosixFilePermission.OWNER_EXECUTE,
                ),
                perms,
            )
        } finally {
            home.toFile().deleteRecursively()
        }
    }

    @Test
    fun `sweep removes only files older than the threshold`() {
        val dir = Files.createTempDirectory("paste-store-sweep-")
        try {
            val fresh = dir.resolve("fresh.txt")
            val stale = dir.resolve("stale.txt")
            Files.writeString(fresh, "x")
            Files.writeString(stale, "x")
            val now = System.currentTimeMillis()
            Files.setLastModifiedTime(stale, java.nio.file.attribute.FileTime.fromMillis(now - 30L * 24 * 60 * 60 * 1000))

            val removed = PasteTempStore.sweepStale(dir, maxAgeMs = 7L * 24 * 60 * 60 * 1000, now = now)

            assertEquals(listOf(stale.fileName.toString()), removed.map { it.fileName.toString() })
            assertTrue(Files.exists(fresh))
            assertTrue(!Files.exists(stale))
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `deleteAll removes the tracked files and tolerates missing ones`() {
        val dir = Files.createTempDirectory("paste-store-delete-")
        try {
            val a = dir.resolve("a.txt")
            val b = dir.resolve("b.txt")
            Files.writeString(a, "x")
            Files.writeString(b, "x")
            val removed = PasteTempStore.deleteAll(listOf(a, b, dir.resolve("gone.txt")))
            assertEquals(2, removed)
            assertTrue(!Files.exists(a))
            assertTrue(!Files.exists(b))
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `the default sweep window is one day (crash leftovers do not linger a week)`() {
        assertEquals(24L * 60 * 60 * 1000, PasteTempStore.STALE_AFTER_MS)
    }
}
