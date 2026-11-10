package dev.pi.agent.bridge

import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.Transferable
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * 从 AWT 拖拽的 [Transferable] 里取出真实文件路径（spec 016 真机补强）。
 *
 * 原先只靠 `CefDragHandler.onDragEnter` 的 `CefDragData.getFileNames()`：
 * 那是 CF_HDROP 通道，IDEA 项目树 / 编辑器标签的内部拖拽不一定走它，
 * 真机上就会出现「拖过去什么都没发生」。AWT 的 DropTarget 旁听拿到的
 * 是同一次拖拽的 Transferable，IntelliJ 会在这里提供
 * `javaFileListFlavor`（项目文件的绝对路径）、`text/uri-list` 或纯文本路径，
 * 因此作为第二条真路径来源。
 *
 * 只接受**确实存在的绝对路径**：编辑器里拖一段代码也会带 stringFlavor，
 * 不能把 `const answer = 42;` 之类文本变成引用。
 */
object DropPaths {

    /** 一次拖拽最多转成多少个引用，防止把整个目录树塞进输入框。 */
    private const val MAX_PATHS = 200

    fun from(transferable: Transferable): List<String> {
        val out = LinkedHashSet<String>()
        readFileList(transferable, out)
        readUriList(transferable, out)
        readStringFlavor(transferable, out)
        return out.toList().take(MAX_PATHS)
    }

    /** `DataFlavor.javaFileListFlavor`：项目视图拖拽的主通道，元素是 File。 */
    private fun readFileList(t: Transferable, out: MutableSet<String>) {
        if (!t.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) return
        val data = runCatching { t.getTransferData(DataFlavor.javaFileListFlavor) }.getOrNull() ?: return
        val items = data as? List<*> ?: return
        for (item in items) {
            val raw = when (item) {
                is File -> item.absolutePath
                is Path -> item.toString()
                is String -> item
                else -> null
            }
            addExisting(out, raw)
        }
    }

    /** `text/uri-list`：OS 资源管理器与部分 IDE 内部拖拽给的是 file:// URI。 */
    private fun readUriList(t: Transferable, out: MutableSet<String>) {
        for (flavor in t.transferDataFlavors ?: emptyArray()) {
            val mime = runCatching { flavor.mimeType }.getOrNull() ?: continue
            if (!mime.startsWith("text/uri-list", ignoreCase = true)) continue
            val text = runCatching { t.getTransferData(flavor) as? String }.getOrNull() ?: continue
            for (line in text.split("\r", "\n")) {
                val token = line.trim()
                if (token.isEmpty() || token.startsWith("#")) continue
                val path = when {
                    token.startsWith("file:", ignoreCase = true) -> runCatching {
                        Paths.get(URI(token)).toString()
                    }.getOrNull() ?: continue
                    else -> token
                }
                addExisting(out, path)
            }
        }
    }

    /** `stringFlavor` 兜底：只有整行是存在的文件系统绝对路径才收下。 */
    private fun readStringFlavor(t: Transferable, out: MutableSet<String>) {
        if (!t.isDataFlavorSupported(DataFlavor.stringFlavor)) return
        val text = runCatching { t.getTransferData(DataFlavor.stringFlavor) as? String }.getOrNull() ?: return
        for (line in text.split("\r", "\n")) {
            val token = line.trim().trim('"')
            // 只认绝对路径：相对路径可能来自代码、日志或普通文本，误判代价更高。
            val p = runCatching { Paths.get(token) }.getOrNull() ?: continue
            if (!p.isAbsolute) continue
            addExisting(out, p.toString())
        }
    }

    private fun addExisting(out: MutableSet<String>, raw: String?) {
        if (raw.isNullOrBlank()) return
        val p = runCatching { Paths.get(raw.trim().trim('"')) }.getOrNull() ?: return
        if (!p.isAbsolute) return
        if (runCatching { Files.exists(p) }.getOrDefault(false)) out.add(p.toString())
    }
}
