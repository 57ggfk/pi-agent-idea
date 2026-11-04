package dev.pi.agent.manage

import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** First-run detection and the install it offers. */
class PiEnvironmentTest {

    @Test
    fun `official registry is the default for unknown sources`() {
        assertEquals("https://registry.npmjs.org", PiEnvironment.registryFor(null))
        assertEquals("https://registry.npmjs.org", PiEnvironment.registryFor("official"))
        assertEquals("https://registry.npmjs.org", PiEnvironment.registryFor("something-else"))
    }

    @Test
    fun `china mirror is selectable`() {
        assertEquals("https://registry.npmmirror.com", PiEnvironment.registryFor("china"))
    }

    @Test
    fun `install args pin both the package and the registry`() {
        assertEquals(
            listOf(
                "/usr/bin/npm",
                "install",
                "-g",
                PiEnvironment.PI_PACKAGE,
                "--registry=https://registry.npmmirror.com",
            ),
            PiEnvironment.installArgs("/usr/bin/npm", "china"),
        )
    }

    @Test
    fun `detect reports a machine with nothing installed`() {
        val env = PiEnvironment.detect(
            locate = { null },
            nodePath = { null },
            npmPath = { null },
            versionOf = { _, _ -> null },
        )
        assertTrue(env["needsSetup"]!!.jsonPrimitive.boolean)
        assertFalse(env["canInstall"]!!.jsonPrimitive.boolean)
        assertFalse(env["nodeOk"]!!.jsonPrimitive.boolean)
        assertFalse(env["node"]!!.jsonObject["found"]!!.jsonPrimitive.boolean)
        assertFalse(env["pi"]!!.jsonObject["found"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `detect reports node version and gating`() {
        val env = PiEnvironment.detect(
            locate = { null },
            nodePath = { "/usr/bin/node" },
            npmPath = { "/usr/bin/npm" },
            versionOf = { _, command -> if (command.contains("-v")) "v20.11.0" else null },
        )
        assertEquals(20, env["nodeMajor"]!!.jsonPrimitive.intOrNull)
        assertTrue(env["nodeOk"]!!.jsonPrimitive.boolean)
        assertTrue(env["canInstall"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun `an old node is detected but not accepted`() {
        val env = PiEnvironment.detect(
            locate = { null },
            nodePath = { "/usr/bin/node" },
            npmPath = { "/usr/bin/npm" },
            versionOf = { _, _ -> "v16.20.2" },
        )
        assertEquals(16, env["nodeMajor"]!!.jsonPrimitive.intOrNull)
        assertFalse(env["nodeOk"]!!.jsonPrimitive.boolean)
    }
}
