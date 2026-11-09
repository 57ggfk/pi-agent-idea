package dev.pi.agent.manage

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Spec 001 US2/US3: package and self-update forward `pi update` verbatim and
 * never guess the outcome. The CLI is injected, so the tests pin the command
 * assembly (T012/T015) and the success/failure mapping without a real pi.
 */
class PiManageUpdateTest {

    /** Records every call; the response is the injected CLI outcome. */
    private class FakeRunner : (List<String>, Long) -> CliResult {
        val calls = mutableListOf<Pair<List<String>, Long>>()
        var response: CliResult = CliResult(0, "ok", "")

        override fun invoke(args: List<String>, timeoutSeconds: Long): CliResult {
            calls += args to timeoutSeconds
            return response
        }
    }

    private fun params(vararg pairs: Pair<String, String>): JsonObject = buildJsonObject {
        pairs.forEach { (k, v) -> put(k, v) }
    }

    // -- T012: package update -------------------------------------------------

    @Test
    fun `package update forwards pi update with the source and install timeout`() {
        val runner = FakeRunner()
        PiManage.packageUpdate(params("source" to "npm:@example/pi-tools"), runner = runner)

        assertEquals(1, runner.calls.size)
        assertEquals(listOf("update", "npm:@example/pi-tools"), runner.calls.single().first)
        assertEquals(PiManage.UPDATE_TIMEOUT_SECONDS, runner.calls.single().second)
    }

    @Test
    fun `package update success relays pi's own output`() {
        val runner = FakeRunner().apply { response = CliResult(0, "updated @example/pi-tools to 1.1.0\n", "") }

        val result = PiManage.packageUpdate(params("source" to "npm:@example/pi-tools"), runner = runner)

        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        assertEquals(0, result["exitCode"]!!.jsonPrimitive.content.toInt())
        assertTrue(result["output"]!!.jsonPrimitive.content.contains("updated @example/pi-tools to 1.1.0"))
    }

    @Test
    fun `package update failure passes the exit code and stderr through`() {
        val runner = FakeRunner().apply { response = CliResult(1, "", "npm error code E404\nnpm error 404 not found") }

        val result = PiManage.packageUpdate(params("source" to "npm:@example/pi-tools"), runner = runner)

        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertEquals(1, result["exitCode"]!!.jsonPrimitive.content.toInt())
        val output = result["output"]!!.jsonPrimitive.content
        assertTrue(output.contains("npm error code E404"), "raw stderr must be relayed, got: $output")
    }

    @Test
    fun `package update without a source is a structured error`() {
        val result = PiManage.packageUpdate(JsonObject(emptyMap()))
        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertTrue(result["error"]!!.jsonPrimitive.content.contains("missing source"))
    }

    // -- 018 US6: package update all -------------------------------------------

    @Test
    fun `package update all runs pi update --extensions with the install timeout`() {
        val runner = FakeRunner()
        PiManage.packageUpdateAll(runner = runner)

        assertEquals(1, runner.calls.size)
        assertEquals(listOf("update", "--extensions"), runner.calls.single().first)
        assertEquals(PiManage.UPDATE_TIMEOUT_SECONDS, runner.calls.single().second)
    }

    @Test
    fun `package update all relays pi's per-package output verbatim`() {
        val runner = FakeRunner().apply {
            response = CliResult(0, "updated @example/a to 1.2.0\n@example/b already up to date\n", "")
        }

        val result = PiManage.packageUpdateAll(runner = runner)

        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        val output = result["output"]!!.jsonPrimitive.content
        assertTrue(output.contains("already up to date"), "per-package lines must be relayed, got: $output")
    }

    @Test
    fun `package update all failure passes the exit code and stderr through`() {
        val runner = FakeRunner().apply { response = CliResult(1, "", "npm error EACCES: permission denied") }

        val result = PiManage.packageUpdateAll(runner = runner)

        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertEquals(1, result["exitCode"]!!.jsonPrimitive.content.toInt())
        assertTrue(result["output"]!!.jsonPrimitive.content.contains("EACCES"))
    }

    // -- T015/T018: pi self update --------------------------------------------

    @Test
    fun `self update runs pi update --self with the install timeout`() {
        val runner = FakeRunner()
        PiManage.envUpdate(runner = runner)

        assertEquals(1, runner.calls.size)
        assertEquals(listOf("update", "--self"), runner.calls.single().first)
        assertEquals(PiManage.UPDATE_TIMEOUT_SECONDS, runner.calls.single().second)
    }

    @Test
    fun `self update success refreshes the located version`() {
        val runner = FakeRunner().apply { response = CliResult(0, "pi updated to 9.9.9", "") }
        var refreshed = false
        val result = PiManage.envUpdate(
            runner = runner,
            refresh = { refreshed = true },
            currentVersion = { "9.9.9" },
        )

        assertTrue(refreshed, "a successful update must refresh the located installation")
        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        assertEquals("9.9.9", result["version"]!!.jsonPrimitive.content)
    }

    @Test
    fun `self update failure does not refresh and keeps pi's output`() {
        val runner = FakeRunner().apply { response = CliResult(1, "", "npm error EACCES: permission denied") }
        var refreshed = false
        val result = PiManage.envUpdate(
            runner = runner,
            refresh = { refreshed = true },
            currentVersion = { "1.4.0" },
        )

        assertFalse(refreshed, "a failed update must not touch the cached installation")
        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertEquals("1.4.0", result["version"]!!.jsonPrimitive.content)
        assertTrue(result["output"]!!.jsonPrimitive.content.contains("EACCES"))
    }

    // -- 011 T021: one shaping pass for the output text ------------------------

    @Test
    fun `update output is sanitized - ansi and progress frames go, chinese stays`() {
        val esc = "\u001B"
        val runner = FakeRunner().apply {
            response = CliResult(
                0,
                "${esc}[32m10%${esc}[0m\r50%\r安装完成 → pi 1.5.0\n${esc}]0;title\u0007done",
                "",
            )
        }
        val result = PiManage.envUpdate(runner = runner, refresh = {}, currentVersion = { "1.5.0" })

        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        // the last \r frame of each line wins, ANSI/OSC vanish, the Chinese
        // text survives — and on a real run drainThread has already turned
        // \r into \n, so this shape matches production end to end.
        assertEquals("安装完成 → pi 1.5.0\ndone", result["output"]!!.jsonPrimitive.content)
    }

    @Test
    fun `update output truncates on code points with the ellipsis marker`() {
        val runner = FakeRunner().apply { response = CliResult(0, "中".repeat(2500), "") }
        val result = PiManage.envUpdate(runner = runner, refresh = {}, currentVersion = { "1.5.0" })

        val output = result["output"]!!.jsonPrimitive.content
        assertEquals(2001, output.codePointCount(0, output.length))
        assertTrue(output.endsWith("…"))
        assertTrue(!output.contains("\uFFFD"))
    }

    @Test
    fun `failed update output carries both streams sanitized`() {
        val esc = "\u001B"
        val runner = FakeRunner().apply {
            response = CliResult(1, "${esc}[31mERR!${esc}[0m npm warn 已跳过可选依赖", "")
        }
        val result = PiManage.envUpdate(runner = runner, refresh = {}, currentVersion = { "1.4.0" })

        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertEquals("ERR! npm warn 已跳过可选依赖", result["output"]!!.jsonPrimitive.content)
    }
}
