package dev.pi.agent.manage

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The tier builders and the subprocess-env wiring are pure functions on plain
 * values so they can be pinned without an IDE project. The IDE-dependent
 * collection itself degrades per tier (FR-001) — that is exercised on the
 * real machine (WebStorm has no Java SDK: the sdk tier must come out absent).
 */
class PiIdeEnvTiersTest {

    @Test
    fun `sdk tier renders name, version, home and language level`() {
        val tier = PiIdeEnv.sdkTier("Oracle JDK 21", "21.0.1", "/opt/jdk-21", "21")!!
        assertEquals("sdk", tier.tier)
        assertTrue(tier.lines.any { it.contains("Oracle JDK 21") && it.contains("21.0.1") })
        assertTrue(tier.lines.any { it.contains("/opt/jdk-21") })
        assertTrue(tier.lines.any { it.contains("Java language level: 21") })
    }

    @Test
    fun `sdk tier is absent when nothing is known (US5 degrade)`() {
        assertNull(PiIdeEnv.sdkTier(null, null, null, null))
    }

    @Test
    fun `language level alone still produces the sdk tier`() {
        val tier = PiIdeEnv.sdkTier(null, null, null, "17")!!
        assertTrue(tier.lines.any { it.contains("Java language level: 17") })
    }

    @Test
    fun `node tier prefers the project interpreter and appends the PATH fallback`() {
        val tier = PiIdeEnv.nodeTier("/home/u/node", "/usr/local/node", "22.19.0")!!
        assertEquals("node-sdk", tier.tier)
        assertTrue(tier.lines.any { it.contains("/home/u/node") && it.contains("JS plugin") })
        assertTrue(tier.lines.any { it.contains("/usr/local/node") && it.contains("v22.19.0") })
    }

    @Test
    fun `node tier absent when neither the plugin nor PATH offers node`() {
        assertNull(PiIdeEnv.nodeTier(null, null, null))
    }

    @Test
    fun `node tier survives a missing version string`() {
        val tier = PiIdeEnv.nodeTier(null, "/usr/local/node", null)!!
        assertTrue(tier.lines.single().contains("/usr/local/node"))
        assertFalse(tier.lines.single().contains("vnull"))
    }

    @Test
    fun `env tier lists filtered variables and the cached shell PATH`() {
        val tier = PiIdeEnv.envTier(mapOf("JAVA_HOME" to "/opt/jdk-21"), listOf("/usr/local/bin", "/opt/bin"))!!
        assertEquals("shell-env", tier.tier)
        assertTrue(tier.lines.any { it == "JAVA_HOME=/opt/jdk-21" })
        assertTrue(tier.lines.any { it.contains("/usr/local/bin") })
    }

    @Test
    fun `env tier absent when nothing survived the filter`() {
        assertNull(PiIdeEnv.envTier(emptyMap(), emptyList()))
    }

    @Test
    fun `applyToProcess adds the snapshot path and diff-only variables (FR-005)`() {
        val env = mutableMapOf("PATH" to "/usr/bin", "JAVA_HOME" to "/existing/jdk")
        PiIdeEnv.applyToProcess(
            env,
            source = mapOf(
                "JAVA_HOME" to "/opt/jdk-21",
                "VIRTUAL_ENV" to "/proj/.venv",
                "GITHUB_TOKEN" to "ghp_x",
            ),
            snapshotPath = "/cfg/pi-agent/pi-ide-env.json",
        )
        assertEquals("/existing/jdk", env["JAVA_HOME"], "只增不改: existing values are never overridden")
        assertEquals("/proj/.venv", env["VIRTUAL_ENV"])
        assertEquals("/cfg/pi-agent/pi-ide-env.json", env["PI_IDE_ENV_SNAPSHOT"], "plugin-owned variable carries the PI_IDE_ prefix")
        assertFalse("GITHUB_TOKEN" in env)
    }

    @Test
    fun `node manager candidates target the JS plugin's public manager`() {
        assertTrue(PiIdeEnv.NODE_MANAGER_CANDIDATES.all { it.startsWith("com.intellij") || it.startsWith("org.jetbrains") })
        assertTrue(PiIdeEnv.NODE_MANAGER_CANDIDATES.any { it.endsWith("NodeJsInterpreterManager") })
    }
}
