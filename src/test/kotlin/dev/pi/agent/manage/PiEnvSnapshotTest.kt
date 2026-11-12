package dev.pi.agent.manage

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The snapshot is the ONLY path IDE facts take into pi's system prompt, so the
 * filters live here as pure functions and get exercised without an IDE
 * (spec 032 验证计划: 假 SDK 快照 / 敏感过滤 / 档位缺失).
 */
class PiEnvSnapshotTest {

    private fun fakeTiers(): List<PiEnvSnapshot.Tier> = listOf(
        PiEnvSnapshot.Tier(
            "sdk",
            "Project SDK",
            listOf("JDK: Oracle JDK 21 (home: /opt/jdk-21)"),
        ),
        PiEnvSnapshot.Tier(
            "node-sdk",
            "Node interpreter",
            listOf("node: v22.19.0 (home: /usr/local/node)"),
        ),
    )

    @Test
    fun `snapshot renders tiers with collection time and tier labels`() {
        val text = PiEnvSnapshot.render(
            collectedAt = "2026-11-13T03:00:00Z",
            tiers = fakeTiers(),
            commands = listOf("Build: mvn -q -DskipTests package"),
        )
        assertTrue(text.contains("Collected: 2026-11-13T03:00:00Z"), "FR-007: the timestamp must be visible")
        assertTrue(text.contains("(tier: sdk)"), "FR-007: tier labels let the model judge provenance")
        assertTrue(text.contains("Oracle JDK 21"))
        assertTrue(text.contains("v22.19.0"))
        assertTrue(text.contains("Build: mvn -q -DskipTests package"))
    }

    @Test
    fun `empty tiers degrade to a detected-nothing block instead of throwing`() {
        val text = PiEnvSnapshot.render("t", emptyList(), emptyList())
        assertTrue(text.contains("No IDE environment facts were detected"))
        assertFalse(text.contains("(tier: "))
    }

    @Test
    fun `env filter keeps build variables and drops credentials (US6)`() {
        val filtered = PiEnvSnapshot.filterEnvVars(
            mapOf(
                "JAVA_HOME" to "/opt/jdk-21",
                "GRADLE_HOME" to "/opt/gradle",
                "VIRTUAL_ENV" to "/proj/.venv",
                "GITHUB_TOKEN" to "ghp_super_secret",
                "DB_PASSWORD" to "hunter2",
                "AWS_SECRET_ACCESS_KEY" to "wJalrXUtnFEMI",
                "MY_API_KEY" to "sk-123",
                "AUTH_FILE" to "/tmp/auth",
                "SOME_RANDOM_VAR" to "not whitelisted",
            ),
        )
        assertTrue("JAVA_HOME" in filtered)
        assertTrue("GRADLE_HOME" in filtered)
        assertTrue("VIRTUAL_ENV" in filtered)
        assertFalse("GITHUB_TOKEN" in filtered)
        assertFalse("DB_PASSWORD" in filtered)
        assertFalse("AWS_SECRET_ACCESS_KEY" in filtered)
        assertFalse("MY_API_KEY" in filtered)
        assertFalse("AUTH_FILE" in filtered)
        assertFalse("SOME_RANDOM_VAR" in filtered)
    }

    @Test
    fun `long values are truncated`() {
        val long = "x".repeat(500)
        val filtered = PiEnvSnapshot.filterEnvVars(mapOf("JAVA_HOME" to long))
        assertEquals(121, filtered["JAVA_HOME"]!!.length)
        assertTrue(filtered["JAVA_HOME"]!!.endsWith("…"))
    }

    @Test
    fun `additions are diff-only and blacklist applies to the subprocess too (FR-005)`() {
        val additions = PiEnvSnapshot.whitelistAdditions(
            current = mapOf("PATH" to "/usr/bin", "JAVA_HOME" to "/existing/jdk"),
            source = mapOf(
                "JAVA_HOME" to "/opt/jdk-21", // already present → must NOT override
                "VIRTUAL_ENV" to "/proj/.venv", // absent → added
                "GITHUB_TOKEN" to "ghp_x", // blacklisted even though missing → dropped
            ),
        )
        assertFalse("JAVA_HOME" in additions, "只增不改: an existing variable is never overwritten")
        assertEquals("/proj/.venv", additions["VIRTUAL_ENV"])
        assertFalse("GITHUB_TOKEN" in additions)
    }

    @Test
    fun `command suggestions follow marker files only`() {
        val maven = PiEnvSnapshot.suggestedCommands(listOf("pom.xml"))
        assertTrue(maven.any { it.contains("mvn") })
        val gradle = PiEnvSnapshot.suggestedCommands(listOf("build.gradle.kts"))
        assertTrue(gradle.any { it.contains("./gradlew") })
        val npm = PiEnvSnapshot.suggestedCommands(listOf("package.json"))
        assertTrue(npm.any { it.contains("npm") })
        val none = PiEnvSnapshot.suggestedCommands(listOf("README.md"))
        assertTrue(none.isEmpty())
    }
}
