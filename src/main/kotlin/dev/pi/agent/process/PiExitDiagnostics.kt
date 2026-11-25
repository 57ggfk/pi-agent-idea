package dev.pi.agent.process

/**
 * 051: pi 退出时，病因在 stderr 里，面板却只显示壳话。
 *
 * 原来退出横幅只有一句「pi process closed stdout (exit code 1)」，pi 真正打
 * 出来的第一句 `Error:` 被折在「查看详情」里——用户得展开才知道自己该做什么
 * （真机：cmfc-fis 的 `Unknown provider "ds"`）。
 *
 * 这里把病因从 stderr 里取出来，两处要用：
 * - 退出横幅的标题用它（见 `PiConnectionState.Exited.cause`）；
 * - 兜底重启靠它认出「是 provider 没了」而不是别的启动失败
 *   （[unknownProviderInStderr]）。
 */

/** `Error:` 前缀的行（pi 的错误行一律以它开头）。 */
private val ERROR_LINE = Regex("^[Ee]rror:\\s*(.+)$")

/** pi 拒绝某个 provider 时的那句话。 */
private val UNKNOWN_PROVIDER = Regex("""Unknown provider\s+"([^"]+)"""", RegexOption.IGNORE_CASE)

/**
 * stderr 里第一行错误的正文（去掉 `Error:` 前缀）。
 *
 * 只取第一行：后面的多半是调用栈，属于详情、不属于标题。
 */
internal fun exitCause(stderr: String?): String? {
    val text = stderr ?: return null
    for (raw in text.lineSequence()) {
        val line = raw.trim()
        if (line.isEmpty()) continue
        val match = ERROR_LINE.matchEntire(line) ?: continue
        return match.groupValues[1].trim().ifEmpty { null }
    }
    return null
}

/**
 * stderr 里被 pi 拒绝的 provider 名（没有则 null）。
 *
 * 扫全部行而不是只看第一行错误：pi 可能先报别的错再报这个，或者把两行
 * 拼在同一条里。
 */
internal fun unknownProviderInStderr(stderr: String?): String? {
    val text = stderr ?: return null
    for (raw in text.lineSequence()) {
        val match = UNKNOWN_PROVIDER.find(raw) ?: continue
        return match.groupValues[1]
    }
    return null
}
