package dev.pi.agent

import java.io.InputStreamReader
import java.util.Properties
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.w3c.dom.Document
import org.w3c.dom.Element

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
        assertTrue(zh.getProperty("action.PiAgent.GenerateCommitMessage.text")!!.contains("Pi"))
        assertTrue(en.getProperty("action.PiAgent.SendFile.text")!!.contains("Pi Agent"))
    }

    /**
     * The menu items are localized by ID, not by a %key reference: the platform
     * only expands `action.<id>.text` for an <action> that declares NO text
     * attribute. 0.5.4 wrote text="%action.addDirectory.text" and every right
     * click menu rendered the raw key instead. This test pins both halves of
     * the contract so the mistake cannot come back silently.
     */
    @Test
    fun `plugin xml actions resolve through their id keys`() {
        val doc = loadPluginXml()
        val actionNodes = doc.getElementsByTagName("action")
        val checked = mutableSetOf<String>()

        for (i in 0 until actionNodes.length) {
            val element = actionNodes.item(i) as Element
            val id = element.getAttribute("id")
            assertTrue(id.isNotEmpty(), "<action> without id in plugin.xml")

            // A literal %key in text/description is never expanded by the
            // platform — the menu would show the key itself.
            for (attr in listOf("text", "description")) {
                val value = element.getAttribute(attr)
                assertTrue(
                    !value.startsWith("%"),
                    "action $id: $attr=\"$value\" would render verbatim; drop the attribute " +
                        "and let the platform use action.$id.$attr",
                )
            }
            assertTrue(
                en.getProperty("action.$id.text") != null,
                "missing action.$id.text in PiAgentBundle.properties",
            )
            checked += id
        }

        // Guard against stale entries: every action.* key must belong to a
        // registered action, otherwise a rename leaves a dead translation
        // behind and the menu silently loses its text.
        val actionKeys = (en.stringPropertyNames() + zh.stringPropertyNames())
            .filter { it.startsWith("action.") }
            .map { it.removePrefix("action.").substringBeforeLast('.') }
            .toSet()
        assertEquals(checked, actionKeys, "action ids in plugin.xml vs bundle keys")
    }

    @Test
    fun `plugin xml groups do not use raw key references`() {
        val doc = loadPluginXml()
        val groupNodes = doc.getElementsByTagName("group")
        for (i in 0 until groupNodes.length) {
            val element = groupNodes.item(i) as Element
            val id = element.getAttribute("id")
            for (attr in listOf("text", "description")) {
                val value = element.getAttribute(attr)
                assertTrue(
                    !value.startsWith("%"),
                    "group $id: $attr=\"$value\" would render verbatim",
                )
            }
        }
    }

    private fun loadPluginXml(): Document {
        val stream = javaClass.classLoader.getResourceAsStream("META-INF/plugin.xml")
            ?: throw AssertionError("META-INF/plugin.xml not found on the classpath")
        return stream.use { input ->
            val factory = DocumentBuilderFactory.newInstance()
            // The descriptor has no DTD; refuse external entities outright.
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
            factory.newDocumentBuilder().parse(input)
        }
    }
}
