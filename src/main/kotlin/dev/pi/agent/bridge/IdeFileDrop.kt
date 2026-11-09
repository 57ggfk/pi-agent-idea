package dev.pi.agent.bridge

import java.nio.file.Files
import java.nio.file.Path

/**
 * 拖进内嵌浏览器的那批文件的「真路径」缓冲（spec 016）。
 *
 * HTML5 的 drop 事件拿不到本地绝对路径：Chromium 出于安全只给 `File.name`，
 * 原生拖拽的 `webkitGetAsEntry().fullPath` 也只是 `/文件名`。真正的绝对路径
 * 只有 CEF 侧能看到——`CefDragData.getFileNames()` 在 dragenter 时就被 IDE 拿到。
 * 所以：进入面板时记在这里，前端 drop 时用 `files.takeDrop` 取走并转成引用 chip。
 *
 * 缓冲带 TTL：用户拖进来又拖走（没松手），几秒后另一次无关的 drop 不能把这批
 * 文件顺手带上。
 */
class IdeFileDrop(
    private val ttlMs: Long = DEFAULT_TTL_MS,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    private val lock = Any()
    private var paths: List<String> = emptyList()
    private var recordedAt = 0L

    /**
     * 记录刚刚进入浏览器的那次拖拽所携带的文件路径。
     * 传空列表是**有效信息**：这次拖的是文字/链接，必须让上一次的文件记录失效。
     */
    fun record(newPaths: List<String>) {
        val cleaned = newPaths.map { it.trim() }.filter { it.isNotEmpty() }
        synchronized(lock) {
            paths = cleaned
            recordedAt = clock()
        }
    }

    /** 取走缓冲（一次性）。已过期或为空都返回空列表。 */
    fun take(): List<String> = synchronized(lock) {
        val fresh = paths.isNotEmpty() && clock() - recordedAt <= ttlMs
        val out = if (fresh) paths else emptyList()
        paths = emptyList()
        recordedAt = 0L
        out
    }

    companion object {
        /** 一次拖拽从 dragenter 到 drop 通常几十毫秒；60s 只为容错。 */
        const val DEFAULT_TTL_MS = 60_000L
    }
}

/** 一个引用 chip 的落点：路径（项目内已转相对）+ 是否目录。 */
data class DropRef(val path: String, val dir: Boolean)

/**
 * 绝对/相对路径 → 引用 chip 的路径换算（spec 015/016 共用）。
 *
 * 项目内的绝对路径转成相对路径（chip 上可读、`@` token 更短），项目外原样保留
 * ——pi 读绝对路径没问题。目录标志以文件系统为准，探不到（路径已不存在、
 * 或调用方只是文本猜测）时退回调用方给的提示值。
 */
object DropRefs {

    fun resolve(root: Path?, inputs: List<Pair<String, Boolean>>): List<DropRef> {
        val out = ArrayList<DropRef>(inputs.size)
        for ((rawPath, dirHint) in inputs) {
            resolveOne(root, rawPath, dirHint)?.let { out.add(it) }
        }
        return out
    }

    fun resolveOne(root: Path?, rawInput: String, dirHint: Boolean): DropRef? {
        val raw = rawInput.trim().trimEnd('/')
        if (raw.isEmpty()) return null
        val p = runCatching { Path.of(raw) }.getOrNull() ?: return null
        val relative = if (p.isAbsolute && root != null && p.startsWith(root)) {
            runCatching { root.relativize(p).toString().replace('\\', '/') }.getOrNull()
        } else {
            null
        }
        val resolved = when {
            p.isAbsolute -> p
            root != null -> root.resolve(raw)
            else -> null
        }
        val isDir = resolved?.let { Files.isDirectory(it) } ?: dirHint
        return DropRef(relative?.takeIf { it.isNotEmpty() } ?: raw, isDir)
    }
}
