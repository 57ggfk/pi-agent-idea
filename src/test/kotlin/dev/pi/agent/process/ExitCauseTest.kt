package dev.pi.agent.process

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * 051: 退出横幅原来只有一句壳话「pi process closed stdout (exit code 1)」，
 * 真正的病因——pi 打在 stderr 上的第一句 `Error:`——被折在「查看详情」里，
 * 用户得展开才知道自己要做什么（真机：cmfc-fis 的 Unknown provider "ds"）。
 *
 * 这里锁两件事：病因怎么从 stderr 里取出来，以及 provider 名怎么从病因里读出来
 * （兜底重试要靠它判断「是 provider 没了」而不是别的启动失败）。
 */
class ExitCauseTest {

    @Test
    fun `the first error line becomes the cause`() {
        assertEquals(
            """Unknown provider "ds". Use --list-models to see available providers/models.""",
            exitCause(
                """Error: Unknown provider "ds". Use --list-models to see available providers/models.""",
            ),
        )
    }

    @Test
    fun `a stack trace after the error does not become the cause`() {
        assertEquals("boom", exitCause("Error: boom\n    at somewhere\nstack line"))
    }

    @Test
    fun `stderr without an error line has no cause`() {
        assertNull(exitCause("warning: slow network"))
        assertNull(exitCause(""))
        assertNull(exitCause(null))
    }

    @Test
    fun `the unknown provider is read out of the stderr`() {
        assertEquals(
            "ds",
            unknownProviderInStderr(
                """Error: Unknown provider "ds". Use --list-models to see available providers/models.""",
            ),
        )
    }

    @Test
    fun `another failure names no provider`() {
        assertNull(unknownProviderInStderr("Error: authentication failed"))
        assertNull(unknownProviderInStderr(null))
    }
}
