package dev.pi.agent

import java.io.InputStreamReader
import java.util.Properties
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * IDE-side localization (spec 008 FR-010/FR-011 / T015): the Chinese bundle
 * must carry exactly the English base's keys — a missing key would silently
 * fall back to English mid-menu, and an empty one would blank the menu row.
 */
class PiAgentBundleTest {

    private fun load(name: String): Properties {
        val stream = javaClass.classLoader.getResourceAsStream("messages/$name")
            ?: throw AssertionError("bundle not found on the classpath: messages/$name")
        val props = Properties()
        InputStreamReader(stream, Charsets.UTF_8).use { reader -> props.load(reader) }
        return props
    }

    private val en by lazy { load("PiAgentBundle.properties") }
    private val zh by lazy { load("PiAgentBundle_zh_CN.properties") }

    @Test
    fun `key sets are identical`() {
        val enKeys = en.stringPropertyNames().toSortedSet()
        val zhKeys = zh.stringPropertyNames().toSortedSet()
        assertEquals(enKeys, zhKeys, "en-only: ${enKeys - zhKeys}; zh-only: ${zhKeys - enKeys}")
    }

    @Test
    fun `no empty or placeholder-looking values`() {
        for ((bundle, name) in listOf(en to "en", zh to "zh")) {
            for ((key, value) in bundle) {
                assertTrue(value.toString().isNotBlank(), "$name:$key is blank")
                assertTrue(!value.toString().startsWith("%"), "$name:$key still contains a %key reference")
            }
        }
    }

    @Test
    fun `the chinese bundle is actually translated (at least 10 keys differ)`() {
        val differing = en.stringPropertyNames().count { en.getProperty(it) != zh.getProperty(it) }
        assertTrue(differing >= 10, "only $differing keys differ between en and zh")
    }

    @Test
    fun `brand name and ids stay untranslated (FR-012)`() {
        // The tool window id and action ids never live in the bundle; the
        // group label "Pi Agent" is also kept literal in plugin.xml. The
        // commit-message action keeps "Pi" in both languages.
        assertTrue(zh.getProperty("action.generateCommit.text")!!.contains("Pi"))
        assertTrue(en.getProperty("action.sendFile.text")!!.contains("Pi Agent"))
    }
}
