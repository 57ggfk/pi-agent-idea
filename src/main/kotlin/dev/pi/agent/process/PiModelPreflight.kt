package dev.pi.agent.process

import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.util.concurrent.ConcurrentHashMap

/**
 * 051: 启动前校验——上次记住的 provider，pi 还在认吗？
 *
 * 插件按项目记住上次用的 provider/model（`PiModelPreferences`），启动时原样
 * 拼进 pi 的命令行。provider 一旦被从 `~/.pi/agent/models.json` 里删掉，
 * 这条记忆就变成陈旧的：pi 直接以 `Unknown provider "ds"` 拒绝启动，面板对该
 * 项目彻底瘫痪（真机：2026-11-25，cmfc-fis）。
 *
 * 判定只能问 pi 自己：`pi auth check --provider X --json` 会分清两种本地配置
 * 文件里长得一模一样的情况——
 *
 * | pi 的回答              | 含义                        | 插件该怎么办   |
 * |------------------------|-----------------------------|----------------|
 * | `provider_not_found`   | provider 没了（陈旧记忆）   | 不带它启动     |
 * | `credentials_not_configured` | provider 还在，只是没登录 | **保留**原偏好 |
 * | `ready`                | 一切正常                    | 保留原偏好     |
 *
 * 第二行是这道校验最容易踩的坑：`openrouter` 没凭据时同样不在
 * `pi --list-models` 里，但它是**存在**的——按本地配置文件猜会把用户的模型
 * 选择悄悄改掉。探针自己失败（命令跑不起来、输出不是 JSON）时一律
 * **fail open**（[Verdict.UNKNOWN]）：判定不出 ≠ provider 没了。
 */
internal object PiModelPreflight {

    /** 对「上次记住的 provider」的判定。 */
    enum class Verdict {
        /** pi 还认这个 provider（可能只是没凭据）——照旧用它。 */
        USABLE,

        /** pi 已经不认识这个 provider——它是陈旧记忆，不能再传给 pi。 */
        GONE,

        /** 判定不出（探针失败）——按「还在」处理，绝不擅自丢掉用户的模型。 */
        UNKNOWN,
    }

    private val LOG = Logger.getInstance(PiModelPreflight::class.java)

    private data class Cached(val verdict: Verdict, val at: Long)

    private val cache = ConcurrentHashMap<String, Cached>()

    /**
     * 探针结果的缓存时长。够长，用户在面板里反复重启不会每次都付一次
     * node 启动的代价；够短，把 provider 加回 `models.json` 后不用等太久
     * 就能被认回来。
     */
    private const val TTL_MS = 5 * 60_000L

    /**
     * 问 pi：[provider] 还在吗？
     *
     * 走 `pi auth check` 而不是读本地配置文件：只有 pi 知道「provider 定义
     * 还在、只是没登录」和「provider 根本没了」的区别。
     */
    fun probe(provider: String): Verdict {
        val now = System.currentTimeMillis()
        cache[provider]?.let { if (now - it.at < TTL_MS) return it.verdict }

        // PiCliRunner lives in the manage package; the process package already
        // reaches into it (PiProcessManager → PiIdeEnv), so a qualified call
        // keeps the import graph one-directional.
        val result = dev.pi.agent.manage.PiCliRunner.run(
            listOf("auth", "check", "--provider", provider, "--json", "--no-refresh"),
            // The probe normally answers in under a second; the ceiling only
            // exists so a wedged pi cannot hold the start path hostage.
            timeoutSeconds = 10,
        )
        val verdict = classify(result.stdout)
        // A failed probe is not cached: the next start should try again.
        if (verdict != Verdict.UNKNOWN) cache[provider] = Cached(verdict, now)
        LOG.info("preflight: provider=$provider verdict=$verdict")
        return verdict
    }

    /** Forgets the cached verdict (the catalog changed under us). */
    fun invalidate() {
        cache.clear()
    }

    /**
     * Reads the verdict out of `pi auth check --json`.
     *
     * The JSON is extracted from whatever else pi printed around it, and a
     * payload that cannot be read is [Verdict.UNKNOWN] — never [Verdict.GONE].
     */
    internal fun classify(output: String): Verdict {
        val text = output.trim()
        val start = text.indexOf('{')
        val end = text.lastIndexOf('}')
        if (start < 0 || end <= start) return Verdict.UNKNOWN
        val obj = runCatching {
            Json.parseToJsonElement(text.substring(start, end + 1)) as? JsonObject
        }.getOrNull() ?: return Verdict.UNKNOWN

        val reason = (obj["reason"] as? JsonPrimitive)?.contentOrNull
        val status = (obj["status"] as? JsonPrimitive)?.contentOrNull
        return when {
            reason == "provider_not_found" -> Verdict.GONE
            status != null -> Verdict.USABLE
            else -> Verdict.UNKNOWN
        }
    }
}
