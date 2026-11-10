package dev.pi.agent.bridge

import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * spec 016: the IDE-side half of file drag & drop, without a browser.
 * [IdeFileDrop] is the buffer CEF's drag handler fills and `files.takeDrop`
 * drains; [DropRefs] turns the absolute paths into chip payloads. Both are pure
 * enough to run headless — the actual drag gesture stays a manual test.
 */
class IdeFileDropTest {

    @Test
    fun `a recorded drag is handed out once`() {
        val drop = IdeFileDrop()
        drop.record(listOf("/p/a.kt", " /p/src "))
        assertEquals(listOf("/p/a.kt", "/p/src"), drop.take())
        // Second drain: the composer must not re-add the same files.
        assertTrue(drop.take().isEmpty())
    }

    @Test
    fun `an empty drag clears a previously recorded one`() {
        val drop = IdeFileDrop()
        drop.record(listOf("/p/a.kt"))
        // Dragging selected text over the panel: no files, and the stale batch
        // recorded a moment ago must not ride along with that drop.
        drop.record(emptyList())
        assertTrue(drop.take().isEmpty())
    }

    @Test
    fun `an aborted drag expires instead of attaching to a later drop`() {
        var now = 1_000L
        val drop = IdeFileDrop(ttlMs = 500L, clock = { now })
        drop.record(listOf("/p/a.kt"))
        now += 501L
        assertTrue(drop.take().isEmpty())
    }

    @Test
    fun `blank entries never become references`() {
        val drop = IdeFileDrop()
        drop.record(listOf("", "   ", "/p/a.kt"))
        assertEquals(listOf("/p/a.kt"), drop.take())
    }

    @Test
    fun `an empty CEF drag does not erase the AWT batch`() {
        val drop = IdeFileDrop()
        drop.record(listOf("/p/a.kt"), DropSource.AWT)
        // IDEA 项目树拖拽里 CEF 常常看不到文件；它的空记录不能清掉 AWT 的真路径。
        drop.record(emptyList(), DropSource.CEF)
        assertEquals(listOf("/p/a.kt"), drop.take())
        assertTrue(drop.take().isEmpty())
    }

    @Test
    fun `both sources merge, AWT first, without duplicates`() {
        val drop = IdeFileDrop()
        drop.record(listOf("/p/b.kt"), DropSource.CEF)
        drop.record(listOf("/p/a.kt", "/p/b.kt"), DropSource.AWT)
        assertEquals(listOf("/p/a.kt", "/p/b.kt"), drop.take())
    }

    @Test
    fun `peek shows a pending batch without consuming it`() {
        val drop = IdeFileDrop()
        drop.record(listOf("/p/a.kt"), DropSource.AWT)
        assertEquals(listOf("/p/a.kt"), drop.peek())
        assertEquals(listOf("/p/a.kt"), drop.take())
        assertTrue(drop.peek().isEmpty())
    }

    @Test
    fun `in-project absolute paths become relative and keep the directory flag`(@TempDir root: Path) {
        val dir = Files.createDirectory(root.resolve("src"))
        val file = Files.writeString(root.resolve("README.md"), "x")
        val refs = DropRefs.resolve(root, listOf(dir.toString() to false, file.toString() to false))

        assertEquals(listOf(DropRef("src", true), DropRef("README.md", false)), refs)
    }

    @Test
    fun `out-of-project paths stay absolute`(@TempDir root: Path, @TempDir outside: Path) {
        val file = Files.writeString(outside.resolve("notes.txt"), "x")
        val refs = DropRefs.resolve(root, listOf(file.toString() to false))
        assertEquals(DropRef(file.toString(), false), refs.single())
    }

    @Test
    fun `a path that no longer exists is reported as a file, not a directory`(@TempDir root: Path) {
        val missing = root.resolve("gone").toString()
        // The filesystem is the source of truth; the caller's dir hint is only
        // used when the path cannot be resolved at all (no project root).
        assertEquals(DropRef("gone", false), DropRefs.resolve(root, listOf(missing to true)).single())
        assertEquals(DropRef("gone", false), DropRefs.resolve(root, listOf(missing to false)).single())
    }

    @Test
    fun `the caller's directory hint applies when there is no project root`() {
        assertEquals(DropRef("src", true), DropRefs.resolve(null, listOf("src" to true)).single())
        assertEquals(DropRef("src", false), DropRefs.resolve(null, listOf("src" to false)).single())
    }

    @Test
    fun `a relative path is stat'ed against the project root`(@TempDir root: Path) {
        Files.createDirectory(root.resolve("docs"))
        assertEquals(DropRef("docs", true), DropRefs.resolve(root, listOf("docs/" to false)).single())
    }

    @Test
    fun `missing project root and unusable paths never throw`() {
        assertTrue(DropRefs.resolve(null, emptyList()).isEmpty())
        assertTrue(DropRefs.resolve(null, listOf("" to false)).isEmpty())
        // A path with a NUL byte is invalid on every platform.
        assertTrue(DropRefs.resolve(null, listOf("bad\u0000path" to false)).isEmpty())
    }
}
