package dev.pi.agent.manage

import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** First-run detection and the install it offers. */
class PiEnvironmentTest {

    @Test
    fun `npm default passes no registry flag at all`() {
        assertNull(PiEnvironment.registryFor(PiEnvironment.SOURCE_DEFAULT).takeIf { it.isNotEmpty() })
        assertNull(PiEnvironment.registryFor(null).takeIf { it.isNotEmpty() })
        assertEquals(PiEnvironment.SOURCE_DEFAULT, PiEnvironment.DEFAULT_SOURCE)
        assertEquals(
            listOf("/usr/bin/npm", "install", "-g", PiEnvironment.PI_PACKAGE),
            PiEnvironment.installArgs("/usr/bin/npm", null),
        )
    }

    @Test
    fun `only known sources fall back to the npm default`() {
        // An unknown id (older UI, hand-written payload) must not silently pin a
        // registry the user did not pick.
        assertNull(PiEnvironment.resolveRegistry("something-else", null))
        assertEquals(PiEnvironment.CHINA_REGISTRY, PiEnvironment.resolveRegistry("china", null))
        assertEquals(PiEnvironment.OFFICIAL_REGISTRY, PiEnvironment.resolveRegistry("official", null))
    }

    @Test
    fun `install args pin the registry only when one was chosen`() {
        assertEquals(
            listOf(
                "/usr/bin/npm",
                "install",
                "-g",
                PiEnvironment.PI_PACKAGE,
                "--registry=https://registry.npmmirror.com",
            ),
            PiEnvironment.installArgs("/usr/bin/npm", PiEnvironment.CHINA_REGISTRY),
        )
    }

    @Test
    fun `custom registry accepts bare hosts and plain http mirrors`() {
        assertEquals(
            "https://registry.example.com",
            PiEnvironment.normalizeCustomRegistry("https://registry.example.com"),
        )
        assertEquals(
            "https://registry.example.com",
            PiEnvironment.normalizeCustomRegistry("  registry.example.com/  "),
        )
        // On-prem Nexus on plain HTTP, with a path.
        assertEquals(
            "http://nexus.corp.local:8081/repository/npm-group",
            PiEnvironment.normalizeCustomRegistry("http://nexus.corp.local:8081/repository/npm-group"),
        )
        assertEquals(
            "http://localhost:4873",
            PiEnvironment.normalizeCustomRegistry("localhost:4873"),
        )
    }

    @Test
    fun `custom registry rejects anything that is not one`() {
        assertNull(PiEnvironment.normalizeCustomRegistry(""))
        assertNull(PiEnvironment.normalizeCustomRegistry("   "))
        assertNull(PiEnvironment.normalizeCustomRegistry(null))
        // An .npmrc snippet or a whole command line gets pasted now and then.
        assertNull(PiEnvironment.normalizeCustomRegistry("registry=https://registry.npmjs.org/"))
        assertNull(PiEnvironment.normalizeCustomRegistry("npm install -g pi --registry=x"))
        assertNull(PiEnvironment.normalizeCustomRegistry("file:///tmp/registry"))
        assertNull(PiEnvironment.normalizeCustomRegistry("https://user:pw@registry.example.com"))
        assertNull(PiEnvironment.normalizeCustomRegistry("https://registry example.com"))
    }

    @Test
    fun `custom source is used verbatim after normalisation`() {
        assertEquals(
            "https://registry.example.com",
            PiEnvironment.resolveRegistry(
                PiEnvironment.SOURCE_CUSTOM,
                "registry.example.com",
            ),
        )
        assertNull(PiEnvironment.resolveRegistry(PiEnvironment.SOURCE_CUSTOM, "nonsense"))
    }

    @Test
    fun `an unusable custom registry is refused before npm runs`() {
        var npmLookedUp = false
        val result = PiEnvironment.install(
            source = PiEnvironment.SOURCE_CUSTOM,
            customRegistry = "not a url",
            npmPath = { npmLookedUp = true; "/usr/bin/npm" },
        )
        assertFalse(result["ok"]!!.jsonPrimitive.boolean)
        assertTrue(result["error"]!!.jsonPrimitive.content.contains("registry"))
        // Nothing was executed: the validation runs first.
        assertFalse(npmLookedUp)
    }

    @Test
    fun `stopping when nothing is running is a no-op, not an exception`() {
        val result = PiEnvironment.cancelInstall()
        assertFalse(result["ok"]!!.jsonPrimitive.boolean)
        assertTrue(result["error"]!!.jsonPrimitive.content.contains("no install"))
    }

    @Test
    fun `a second install is refused while one is running`() {
        val started = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val worker = Thread {
            PiEnvironment.install(
                source = PiEnvironment.SOURCE_DEFAULT,
                npmPath = { "/usr/bin/npm" },
                nodePath = { null },
                // Stands in for npm running for a long time: the point is that the
                // slot is held, not what npm prints.
                runner = { _ ->
                    started.countDown()
                    runCatching { release.await(10, java.util.concurrent.TimeUnit.SECONDS) }
                    CliResult(0, "", "")
                },
            )
        }.apply { isDaemon = true; start() }

        assertTrue(started.await(5, java.util.concurrent.TimeUnit.SECONDS))
        val second = PiEnvironment.install(
            source = PiEnvironment.SOURCE_DEFAULT,
            npmPath = { "/usr/bin/npm" },
            nodePath = { null },
            runner = { _ -> CliResult(0, "", "") },
        )
        assertFalse(second["ok"]!!.jsonPrimitive.boolean)
        assertTrue(second["error"]!!.jsonPrimitive.content.contains("already running"))

        release.countDown()
        worker.join(10_000)
        // The slot is free again once the first install finishes.
        assertFalse(PiEnvironment.cancelInstall()["ok"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `an unreachable registry is reported as such, not as a generic failure`() {
        // Verbatim shape of what npm prints behind an internal proxy: recorded
        // from a real run with the registry pointed at a dead port.
        val result = PiEnvironment.install(
            source = PiEnvironment.SOURCE_DEFAULT,
            npmPath = { "/usr/bin/npm" },
            nodePath = { null },
            runner = { _ ->
                CliResult(
                    exitCode = 1,
                    stdout = """
                        npm error code E502
                        npm error 502 Bad Gateway - GET http://127.0.0.1:9/@earendil-works%2fpi-coding-agent
                    """.trimIndent(),
                    stderr = "",
                )
            },
        )
        assertFalse(result["ok"]!!.jsonPrimitive.boolean)
        val message = result["error"]!!.jsonPrimitive.content
        assertTrue(message.contains("unreachable"), message)
        // The raw output is kept so support can see the actual code.
        assertTrue(result["output"]!!.jsonPrimitive.content.contains("E502"))
        // Nothing was pinned: the default request carries no registry back.
        assertEquals("", result["registry"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a permission failure points at the npm prefix`() {
        val result = PiEnvironment.install(
            source = "official",
            npmPath = { "/usr/bin/npm" },
            nodePath = { null },
            runner = { _ ->
                CliResult(1, "npm error code EACCES\nnpm error syscall mkdir", "")
            },
        )
        assertTrue(result["error"]!!.jsonPrimitive.content.contains("permissions"))
        assertEquals(
            PiEnvironment.OFFICIAL_REGISTRY,
            result["registry"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun `detect reports a machine with nothing installed`() {
        val env = PiEnvironment.detect(
            locate = { null },
            nodePath = { null },
            npmPath = { null },
            versionOf = { _, _ -> null },
            configuredRegistry = { null },
        )
        assertTrue(env["needsSetup"]!!.jsonPrimitive.boolean)
        assertFalse(env["canInstall"]!!.jsonPrimitive.boolean)
        assertFalse(env["nodeOk"]!!.jsonPrimitive.boolean)
        assertFalse(env["node"]!!.jsonObject["found"]!!.jsonPrimitive.boolean)
        assertFalse(env["pi"]!!.jsonObject["found"]!!.jsonPrimitive.boolean)
        assertEquals("", env["npmRegistry"]!!.jsonPrimitive.content)
    }

    @Test
    fun `detect reports node version and gating`() {
        val env = PiEnvironment.detect(
            locate = { null },
            nodePath = { "/usr/bin/node" },
            npmPath = { "/usr/bin/npm" },
            versionOf = { _, command -> if (command.contains("-v")) "v20.11.0" else null },
            configuredRegistry = { "https://registry.corp.example.com" },
        )
        assertEquals(20, env["nodeMajor"]!!.jsonPrimitive.intOrNull)
        // 028 FR-003: the corrected gate — 20.11 is BELOW 22.19 now (it used
        // to read as fine under the old major>=18 rule, which is exactly the
        // bug this spec fixes).
        assertFalse(env["nodeOk"]!!.jsonPrimitive.boolean)
        assertFalse(env["canInstall"]!!.jsonPrimitive.boolean)
        assertEquals("node-version", env["installBlocker"]!!.jsonPrimitive.content)
        assertEquals("22.19", env["minNode"]!!.jsonPrimitive.content)
        // The UI labels the "npm default" option with this URL.
        assertEquals(
            "https://registry.corp.example.com",
            env["npmRegistry"]!!.jsonPrimitive.content,
        )
        assertEquals(PiEnvironment.SOURCE_CUSTOM, env["customSource"]!!.jsonPrimitive.content)
    }

    @Test
    fun `an old node is detected but not accepted`() {
        val env = PiEnvironment.detect(
            locate = { null },
            nodePath = { "/usr/bin/node" },
            npmPath = { "/usr/bin/npm" },
            versionOf = { _, _ -> "v16.20.2" },
            configuredRegistry = { null },
        )
        assertEquals(16, env["nodeMajor"]!!.jsonPrimitive.intOrNull)
        assertFalse(env["nodeOk"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `nodeMeetsMin compares major-minor against 22_19 (028 FR-003)`() {
        // The spec's table: false for anything below, true from 22.19 on.
        mapOf(
            "v18.20.0" to false,
            "v20.11.0" to false,
            "v22.18.9" to false,
            "v22.19.0" to true,
            "v23.0.0" to true,
            "v24.1.0" to true,
            // boundary + robustness
            "22.19.3" to true,
            "" to false,
            "garbage" to false,
        ).forEach { (version, expected) ->
            assertEquals(expected, PiEnvironment.nodeMeetsMin(version), "node $version")
        }
    }

    @Test
    fun `installScriptArgs spells the vendor command per platform (028 FR-002)`() {
        val win = PiEnvironment.installScriptArgs(true)
        assertEquals("powershell", win.first())
        assertTrue(win.last().contains("irm https://pi.dev/install.ps1 | iex"))
        val unix = PiEnvironment.installScriptArgs(false)
        assertEquals("sh", unix.first())
        assertTrue(unix.last().contains("curl -fsSL https://pi.dev/install.sh | sh"))
    }

    @Test
    fun `detect names the install blocker (028 FR-009)`() {
        val noNode = PiEnvironment.detect(
            locate = { null }, nodePath = { null }, npmPath = { null },
            versionOf = { _, _ -> null }, configuredRegistry = { null },
        )
        assertEquals("no-node", noNode["installBlocker"]!!.jsonPrimitive.content)
        val noNpm = PiEnvironment.detect(
            locate = { null }, nodePath = { "/usr/bin/node" }, npmPath = { null },
            versionOf = { _, c -> if (c.contains("-v")) "v22.19.0" else null }, configuredRegistry = { null },
        )
        assertEquals("no-npm", noNpm["installBlocker"]!!.jsonPrimitive.content)
        val fine = PiEnvironment.detect(
            locate = { null }, nodePath = { "/usr/bin/node" }, npmPath = { "/usr/bin/npm" },
            versionOf = { _, c -> if (c.contains("-v")) "v24.1.0" else null }, configuredRegistry = { null },
        )
        assertEquals("", fine["installBlocker"]!!.jsonPrimitive.content)
        assertTrue(fine["canInstall"]!!.jsonPrimitive.boolean)
    }
}
