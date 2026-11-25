package dev.pi.agent.process

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 051: 插件按项目记住上次用的 provider/model，启动时原样拼进 pi 的命令行。
 * provider 一旦从 `models.json` 里被删掉，这条记忆就变成陈旧的——pi 会以
 * `Unknown provider "ds"` 拒绝启动，面板对该项目彻底瘫痪（真机：cmfc-fis）。
 *
 * 判定必须问 pi 自己（`pi auth check`），因为「provider 没了」与
 * 「provider 还在、只是没登录凭据」在本地配置文件里长得一模一样：
 * `openrouter` 没凭据时同样不出现在 `pi --list-models` 里，但它是**存在**的，
 * 丢掉它等于替用户改掉了模型选择。只有 pi 能区分这两者。
 */
class PiModelPreflightTest {

    @Test
    fun `a provider pi no longer knows is gone`() {
        assertEquals(
            PiModelPreflight.Verdict.GONE,
            PiModelPreflight.classify(
                """{"status":"not_ready","provider":"ds","reason":"provider_not_found"}""",
            ),
        )
    }

    @Test
    fun `a provider without credentials still exists`() {
        // 没凭据 ≠ provider 没了：这种情况必须保留原偏好，让 pi 自己去报
        // 「没登录」，否则用户的模型选择会被插件悄悄改掉。
        assertEquals(
            PiModelPreflight.Verdict.USABLE,
            PiModelPreflight.classify(
                """{"status":"not_ready","provider":"openrouter","reason":"credentials_not_configured"}""",
            ),
        )
    }

    @Test
    fun `a ready provider is usable`() {
        assertEquals(
            PiModelPreflight.Verdict.USABLE,
            PiModelPreflight.classify(
                """{"status":"ready","provider":"9router","authType":"api_key"}""",
            ),
        )
    }

    @Test
    fun `an unreadable answer never drops the model`() {
        // 探针自己失败时必须 fail open：判定不出 ≠ provider 没了。
        // 宁可让 pi 自己报错，也不能因为一次探针失败就丢掉用户的模型。
        assertEquals(PiModelPreflight.Verdict.UNKNOWN, PiModelPreflight.classify(""))
        assertEquals(PiModelPreflight.Verdict.UNKNOWN, PiModelPreflight.classify("not json at all"))
        assertEquals(
            PiModelPreflight.Verdict.UNKNOWN,
            PiModelPreflight.classify("env: node: No such file or directory"),
        )
    }

    @Test
    fun `noise around the json does not hide the verdict`() {
        assertEquals(
            PiModelPreflight.Verdict.GONE,
            PiModelPreflight.classify(
                """warning: something happened
{"status":"not_ready","provider":"ds","reason":"provider_not_found"}""",
            ),
        )
    }
}
