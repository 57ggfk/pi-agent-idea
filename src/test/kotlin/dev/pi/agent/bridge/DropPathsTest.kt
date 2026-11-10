package dev.pi.agent.bridge

import org.junit.jupiter.api.io.TempDir
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.awt.datatransfer.Transferable
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * spec 016 真机修复：AWT DropTarget 旁听从 Transferable 里取真路径。
 * 不依赖 IDE 运行时，纯 Transferable 就能验证三个 flavour 通道与误判防护。
 */
class DropPathsTest {

    private fun transferable(flavor: DataFlavor, data: Any): Transferable = object : Transferable {
        override fun getTransferDataFlavors(): Array<DataFlavor> = arrayOf(flavor)
        override fun isDataFlavorSupported(f: DataFlavor): Boolean = f == flavor
        override fun getTransferData(f: DataFlavor): Any =
            if (f == flavor) data else throw java.awt.datatransfer.UnsupportedFlavorException(f)
    }

    @Test
    fun `javaFileListFlavor yields the absolute paths a project tree drag carries`(@TempDir root: Path) {
        val file = Files.writeString(root.resolve("A.kt"), "x").toFile()
        val dir = Files.createDirectory(root.resolve("src")).toFile()
        val t = transferable(DataFlavor.javaFileListFlavor, listOf<File>(file, dir))
        assertEquals(listOf(file.absolutePath, dir.absolutePath), DropPaths.from(t))
    }

    @Test
    fun `uri-list file URIs become paths and comments are ignored`(@TempDir root: Path) {
        val file = Files.writeString(root.resolve("B.kt"), "x")
        val flavor = DataFlavor("text/uri-list;class=java.lang.String")
        val t = transferable(flavor, "# a comment\r\n${file.toUri()}\r\n")
        assertEquals(listOf(file.toString()), DropPaths.from(t))
    }

    @Test
    fun `stringFlavour accepts a real absolute path`(@TempDir root: Path) {
        val file = Files.writeString(root.resolve("C.kt"), "x")
        assertEquals(listOf(file.toString()), DropPaths.from(StringSelection(file.toString())))
    }

    @Test
    fun `selected code and relative paths never become references`() {
        assertTrue(DropPaths.from(StringSelection("const answer = 42;\n./gradlew build\n@src")).isEmpty())
        assertTrue(DropPaths.from(StringSelection("store.ts")).isEmpty())
    }

    @Test
    fun `a transferable that refuses every flavour yields nothing`() {
        val t = object : Transferable {
            override fun getTransferDataFlavors(): Array<DataFlavor> = emptyArray()
            override fun isDataFlavorSupported(f: DataFlavor): Boolean = false
            override fun getTransferData(f: DataFlavor): Any = throw java.awt.datatransfer.UnsupportedFlavorException(f)
        }
        assertTrue(DropPaths.from(t).isEmpty())
    }
}
