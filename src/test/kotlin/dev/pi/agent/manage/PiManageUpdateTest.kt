package dev.pi.agent.manage

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Package command semantics (specs 001/018/033): outputs forward verbatim and
 * never guess the outcome. The CLI and the preflight are injected, so the
 * tests pin the command assembly, the registry env and the offline guard
 * without a real pi or network.
 *
 * The single-package `pi update <source>` RPC is gone (033 FR-004): pi 1.5.0
 * rejects every notation (probe P8), so upgrades are version-pinned installs
 * issued by the frontend via [PiManage.packageInstall].
 */
class PiManageUpdateTest {

    /** Records every call; the response is the injected CLI outcome. */
    private class FakeRunner : (List<String>, Long, Map<String, String>) -> CliResult {
        val calls = mutableListOf<Triple<List<String>, Long, Map<String, String>>>()
        var response: CliResult = CliResult(0, "ok", "")

        override fun invoke(args: List<String>, timeoutSeconds: Long, env: Map<String, String>): CliResult {
            calls += Triple(args, timeoutSeconds, env)
            return response
        }

        /** [PiManage.envUpdate] (self update) predates the registry env seam. */
        fun asSelfUpdateRunner(): (List<String>, Long) -> CliResult =
            { args, timeout -> invoke(args, timeout, emptyMap()) }
    }

    private fun params(vararg pairs: Pair<String, String>): JsonObject = buildJsonObject {
        pairs.forEach { (k, v) -> put(k, v) }
    }

    private val reachable = { _: String -> PiPackages.Preflight(true, "") }
    private val offline = { _: String -> PiPackages.Preflight(false, "offline") }

    // -- 033 FR-008: install preflights the registry and never spawns offline --

    @Test
    fun `package install runs pi install with the install timeout when reachable`() {
        val runner = FakeRunner()
        val result = PiManage.packageInstall(params("source" to "npm:@example/pi-tools"), runner = runner, preflight = reachable)

        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        assertEquals(1, runner.calls.size)
        val (args, timeout, env) = runner.calls.single()
        assertEquals(listOf("install", "npm:@example/pi-tools"), args)
        assertEquals(PiManage.INSTALL_TIMEOUT_SECONDS, timeout)
        assertTrue(env.isEmpty(), "follow mode must not inject a registry env")
    }

    @Test
    fun `package install offline is refused before the cli runs`() {
        val runner = FakeRunner()
        val result = PiManage.packageInstall(params("source" to "npm:@example/pi-tools"), runner = runner, preflight = offline)

        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertEquals("offline", result["code"]!!.jsonPrimitive.content)
        assertTrue(runner.calls.isEmpty(), "the npm retry ladder (72s+, P5) must never start offline")
    }

    @Test
    fun `package install carries an explicit registry override as npm env`() {
        val runner = FakeRunner()
        PiManage.packageInstall(
            params("source" to "npm:x", "registry" to "https://registry.example.com"),
            runner = runner,
            preflight = reachable,
        )

        assertEquals(
            mapOf("NPM_CONFIG_REGISTRY" to "https://registry.example.com"),
            runner.calls.single().third,
        )
    }

    @Test
    fun `an invalid registry override is ignored instead of poisoning npm`() {
        val runner = FakeRunner()
        PiManage.packageInstall(
            params("source" to "npm:x", "registry" to "not a registry"),
            runner = runner,
            preflight = reachable,
        )

        assertTrue(runner.calls.single().third.isEmpty())
    }

    // -- 018 US6: package update all -------------------------------------------

    @Test
    fun `package update all runs pi update --extensions with the install timeout`() {
        val runner = FakeRunner()
        PiManage.packageUpdateAll(runner = runner, preflight = reachable)

        assertEquals(1, runner.calls.size)
        assertEquals(listOf("update", "--extensions"), runner.calls.single().first)
        assertEquals(PiManage.UPDATE_TIMEOUT_SECONDS, runner.calls.single().second)
    }

    @Test
    fun `package update all relays pi's per-package output verbatim`() {
        val runner = FakeRunner().apply {
            response = CliResult(0, "updated @example/a to 1.2.0\n@example/b already up to date\n", "")
        }

        val result = PiManage.packageUpdateAll(runner = runner, preflight = reachable)

        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        val output = result["output"]!!.jsonPrimitive.content
        assertTrue(output.contains("already up to date"), "per-package lines must be relayed, got: $output")
    }

    @Test
    fun `package update all failure passes the exit code and stderr through`() {
        val runner = FakeRunner().apply { response = CliResult(1, "", "npm error EACCES: permission denied") }

        val result = PiManage.packageUpdateAll(runner = runner, preflight = reachable)

        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertEquals(1, result["exitCode"]!!.jsonPrimitive.content.toInt())
        assertTrue(result["output"]!!.jsonPrimitive.content.contains("EACCES"))
    }

    @Test
    fun `package update all offline is refused before the cli runs`() {
        val runner = FakeRunner()
        val result = PiManage.packageUpdateAll(runner = runner, preflight = offline)

        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertEquals("offline", result["code"]!!.jsonPrimitive.content)
        assertTrue(runner.calls.isEmpty())
    }

    // -- 033 FR-003: package version check --------------------------------------

    private fun listWithVersion(dir: java.io.File, source: String): () -> String {
        java.io.File(dir, "package.json").writeText("""{"name":"x","version":"0.9.0"}""")
        val path = dir.absolutePath.replace("\\", "\\\\")
        return { "User packages:\n  $source\n    $path\n" }
    }

    @Test
    fun `package check reports up-to-date when installed matches latest`() {
        val dir = Files.createTempDirectory("pi033-check").toFile()
        try {
            val result = PiManage.packageCheck(
                params("source" to "npm:openwiki"),
                listStdout = listWithVersion(dir, "npm:openwiki"),
                preflight = reachable,
                latest = { _, _ -> PiPackages.Latest("0.9.0", "") },
            )

            assertEquals("true", result["ok"]!!.jsonPrimitive.content)
            assertEquals("up-to-date", result["state"]!!.jsonPrimitive.content)
            assertEquals("0.9.0", result["installed"]!!.jsonPrimitive.content)
            assertEquals("0.9.0", result["latest"]!!.jsonPrimitive.content)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `package check reports upgradable when latest moves and carries the target`() {
        val dir = Files.createTempDirectory("pi033-check").toFile()
        try {
            val result = PiManage.packageCheck(
                params("source" to "npm:openwiki"),
                listStdout = listWithVersion(dir, "npm:openwiki"),
                preflight = reachable,
                latest = { _, _ -> PiPackages.Latest("1.0.0", "") },
            )

            assertEquals("upgradable", result["state"]!!.jsonPrimitive.content)
            assertEquals("1.0.0", result["latest"]!!.jsonPrimitive.content)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `package check degrades with reasons instead of failing`() {
        val offline = PiManage.packageCheck(
            params("source" to "npm:openwiki"),
            listStdout = { "" },
            preflight = { PiPackages.Preflight(false, "offline") },
            latest = { _, _ -> throw AssertionError("offline must not reach the registry") },
        )
        assertEquals("unknown", offline["state"]!!.jsonPrimitive.content)
        assertEquals("offline", offline["reason"]!!.jsonPrimitive.content)

        val auth = PiManage.packageCheck(
            params("source" to "npm:openwiki"),
            listStdout = { "" },
            preflight = reachable,
            latest = { _, _ -> PiPackages.Latest(null, "auth") },
        )
        assertEquals("unknown", auth["state"]!!.jsonPrimitive.content)
        assertEquals("auth", auth["reason"]!!.jsonPrimitive.content)

        val git = PiManage.packageCheck(
            params("source" to "git:github.com/example/repo"),
            listStdout = { "" },
            preflight = reachable,
            latest = { _, _ -> throw AssertionError("git sources must not hit the registry") },
        )
        assertEquals("unknown", git["state"]!!.jsonPrimitive.content)
        assertEquals("git-ref", git["reason"]!!.jsonPrimitive.content)
    }

    // -- T015/T018: pi self update --------------------------------------------

    @Test
    fun `self update runs pi update --self with the install timeout`() {
        val runner = FakeRunner()
        PiManage.envUpdate(runner = runner.asSelfUpdateRunner())

        assertEquals(1, runner.calls.size)
        assertEquals(listOf("update", "--self"), runner.calls.single().first)
        assertEquals(PiManage.UPDATE_TIMEOUT_SECONDS, runner.calls.single().second)
    }

    @Test
    fun `self update success refreshes the located version`() {
        val runner = FakeRunner().apply { response = CliResult(0, "pi updated to 9.9.9", "") }
        var refreshed = false
        val result = PiManage.envUpdate(
            runner = runner.asSelfUpdateRunner(),
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
            runner = runner.asSelfUpdateRunner(),
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
        val result = PiManage.envUpdate(runner = runner.asSelfUpdateRunner(), refresh = {}, currentVersion = { "1.5.0" })

        assertEquals("true", result["ok"]!!.jsonPrimitive.content)
        // the last \r frame of each line wins, ANSI/OSC vanish, the Chinese
        // text survives — and on a real run drainThread has already turned
        // \r into \n, so this shape matches production end to end.
        assertEquals("安装完成 → pi 1.5.0\ndone", result["output"]!!.jsonPrimitive.content)
    }

    @Test
    fun `update output truncates on code points with the ellipsis marker`() {
        val runner = FakeRunner().apply { response = CliResult(0, "中".repeat(2500), "") }
        val result = PiManage.envUpdate(runner = runner.asSelfUpdateRunner(), refresh = {}, currentVersion = { "1.5.0" })

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
        val result = PiManage.envUpdate(runner = runner.asSelfUpdateRunner(), refresh = {}, currentVersion = { "1.4.0" })

        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertEquals("ERR! npm warn 已跳过可选依赖", result["output"]!!.jsonPrimitive.content)
    }
}
