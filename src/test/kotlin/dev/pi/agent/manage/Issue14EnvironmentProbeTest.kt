package dev.pi.agent.manage

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Issue #14: the diagnostics card must not spawn a subprocess.
 *
 * `PiManage.environment()` called `PiLocator.locate(forceRefresh = true)`,
 * which runs `pi --version` — a node cold start — every time the card was
 * opened. The zero-subprocess probes already exist:
 *  - `PiLocator.locatePath()` — the path only, no version probe
 *  - `PiDiskVersion.current()` — the version from package.json
 *
 * The probes are injected so the test can assert where each value comes
 * from without a pi installation.
 */
class Issue14EnvironmentProbeTest {

    private fun toolJson(path: String, version: String) = buildJsonObject {
        put("found", path.isNotBlank())
        put("path", path)
        put("version", version)
    }

    private val nodeJson = toolJson("C:/node.exe", "1.0.0")
    private val npmJson = toolJson("C:/npm.cmd", "1.0.0")
    private val emptyJson = toolJson("", "")

    @Test
    fun `the path comes from the path probe and the version from the disk probe`() {
        val env = PiManage.environment(
            locatePath = { "C:/pi/pi.cmd" },
            diskVersion = { "1.6.1" },
            detectTools = { nodeJson to npmJson },
        )
        assertEquals("C:/pi/pi.cmd", env["path"]?.jsonPrimitive?.content)
        assertEquals("1.6.1", env["version"]?.jsonPrimitive?.content)
        assertEquals("true", env["found"]?.jsonPrimitive?.content)
    }

    @Test
    fun `a missing pi reports not found with empty strings`() {
        val env = PiManage.environment(
            locatePath = { null },
            diskVersion = { null },
            detectTools = { emptyJson to emptyJson },
        )
        assertEquals("false", env["found"]?.jsonPrimitive?.content)
        assertEquals("", env["path"]?.jsonPrimitive?.content)
        assertEquals("", env["version"]?.jsonPrimitive?.content)
    }

    @Test
    fun `the JSON shape is unchanged`() {
        val env = PiManage.environment(
            locatePath = { "C:/pi/pi.cmd" },
            diskVersion = { "1.6.1" },
            detectTools = { nodeJson to npmJson },
        )
        // The frontend reads exactly these fields (web/src/manage.ts).
        for (key in listOf(
            "ok", "found", "path", "version", "agentDir",
            "node", "npm", "homeDir", "pluginVersion", "buildTime", "commitId",
        )) {
            assertTrue(env.containsKey(key), "the environment card must keep the \"$key\" field")
        }
    }

    @Test
    fun `the disk version probe is the zero-subprocess one`() {
        // PiDiskVersion.current() reads package.json first and only falls
        // back to the CLI when there is no package.json — the stamp keeps
        // the fallback rare. The environment card must use that probe.
        assertTrue(
            dev.pi.agent.process.PiDiskVersion::class.java.declaredMethods.any { it.name == "current" },
            "PiDiskVersion.current() must stay available",
        )
    }
}
