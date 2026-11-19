package dev.pi.agent.bridge

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID

/**
 * 044 FR-012：粘贴临时文件的存放位置。
 *
 * **为什么不用系统临时目录**：macOS 的 `java.io.tmpdir` 是
 * `/var/folders/<a>/<b>/<c>/T/`——光目录前缀就 52 个字符。拼上文件名后，
 * 插入输入框的 `@path` 引用长达 105 字符，在 402px 的输入区里被折成
 * 三行，既看不清也点不准（真机审查 P1-1）。
 *
 * 改为插件自有的短目录 `~/.pi-agent/pi-paste/`：
 * - 引用路径降到 ~45 字符，输入框里一行放下；
 * - 目录在用户主目录下、**不在项目里**，工作区 / git status 不会被污染
 *   （044 spec Q6 的原始意图不变，只是把「系统临时目录」换成「插件自有短目录」）；
 * - 目录 0700、文件 0600，内容仍然只有本人可读。
 *
 * 生命周期不变：会话结束即清理（FR-013），另加一条「陈旧清扫」兜底
 * 上次崩溃残留的文件（超过 [STALE_AFTER_MS] 才动，避免删掉别的 IDE 实例
 * 仍在用的文件）。
 */
object PasteTempStore {

    /** 用户主目录下的插件自有目录名。 */
    const val HOME_DIR_NAME = ".pi-agent"

    /** 存放粘贴文件的子目录名；前端靠 `pi-paste` 标记识别临时引用（044 FR-014）。 */
    const val DIR_NAME = "pi-paste"

    /** 崩溃残留文件的清扫阈值（24 小时）。 */
    const val STALE_AFTER_MS: Long = 24L * 60 * 60 * 1000

    /** 根目录：`~/.pi-agent/pi-paste`。 */
    fun root(home: String = defaultHome()): Path = Path.of(home, HOME_DIR_NAME, DIR_NAME)

    /** 创建根目录（0700）并返回；失败时抛出，由调用方兜底。 */
    fun ensureRoot(home: String = defaultHome()): Path {
        val dir = root(home)
        Files.createDirectories(dir)
        restrict(dir, "rwx------")
        return dir
    }

    /**
     * 每次 IDE 启动一个短标签：文件名的第一段，保证多次启动之间不重名，
     * 同时短到不会把引用路径撑长。
     */
    fun newTag(): String = UUID.randomUUID().toString().replace("-", "").take(6)

    /** 文件名：`<tag>-<seq>.txt`，例如 `a3f9c2-1.txt`。 */
    fun fileName(tag: String, seq: Int): String = "$tag-$seq.txt"

    /**
     * 清扫陈旧文件：修改时间超过 [maxAgeMs] 的直接删除，返回被删掉的路径。
     * 只在根目录这一层做（不再递归），任何一步失败都只是少删几个文件，
     * 绝不影响正在使用的引用。
     */
    fun sweepStale(
        dir: Path,
        maxAgeMs: Long = STALE_AFTER_MS,
        now: Long = System.currentTimeMillis(),
    ): List<Path> {
        val removed = mutableListOf<Path>()
        runCatching {
            Files.list(dir).use { stream ->
                stream.forEach { file ->
                    val age = now - runCatching { Files.getLastModifiedTime(file).toMillis() }.getOrDefault(0L)
                    if (age > maxAgeMs && runCatching { Files.deleteIfExists(file) }.getOrDefault(false)) {
                        removed.add(file)
                    }
                }
            }
        }
        return removed
    }

    /** 设置 POSIX 权限；文件系统不支持时静默跳过（Windows / 特殊挂载点）。 */
    fun restrict(path: Path, permissions: String) {
        runCatching {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(permissions))
        }
    }

    /**
     * 删掉一批临时文件，返回真正删掉的个数；单个失败不影响其它文件
     * （FR-013：清理失败不得影响会话使用）。
     */
    fun deleteAll(files: Collection<Path>): Int {
        var removed = 0
        files.forEach { file ->
            runCatching {
                if (Files.deleteIfExists(file)) removed++
            }
        }
        return removed
    }

    private fun defaultHome(): String =
        System.getProperty("user.home")?.takeIf { it.isNotBlank() }
            ?: System.getProperty("java.io.tmpdir")
            ?: "."
}
