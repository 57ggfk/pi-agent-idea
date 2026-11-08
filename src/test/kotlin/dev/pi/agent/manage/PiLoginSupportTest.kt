package dev.pi.agent.manage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** spec 014: the JSON-lines protocol between PiLoginSupport and pi-login.mjs. */
class PiLoginSupportTest {

    private fun classify(raw: String) = PiLoginSupport.classify(raw)

    @Test
    fun `ready line classifies`() {
        assertEquals(PiLoginSupport.Line.Ready, classify("""{"t":"ready"}"""))
    }

    @Test
    fun `event line carries the AuthEvent payload`() {
        val line = classify("""{"t":"event","ev":{"type":"auth_url","url":"https://x/auth"}}""")
        assertTrue(line is PiLoginSupport.Line.Event)
        assertEquals("auth_url", line.ev["type"]?.let { Json.parseToJsonElement(it.toString()).jsonPrimitive.content })
    }

    @Test
    fun `prompt line carries id and prompt body`() {
        val line = classify(
            """{"t":"prompt","id":3,"p":{"type":"manual_code","message":"Paste the URL","placeholder":"http://127.0.0.1:1455/auth/callback"}}""",
        )
        assertTrue(line is PiLoginSupport.Line.Prompt)
        assertEquals(3, (line as PiLoginSupport.Line.Prompt).id)
        assertEquals("manual_code", line.p["type"]?.let { Json.parseToJsonElement(it.toString()).jsonPrimitive.content })
    }

    @Test
    fun `done line classifies success failure and cancellation`() {
        val ok = classify("""{"t":"done","ok":true,"provider":"openrouter","type":"oauth"}""")
        assertTrue(ok is PiLoginSupport.Line.Done && ok.ok && ok.provider == "openrouter")
        val fail = classify("""{"t":"done","ok":false,"error":"denied"}""")
        assertTrue(fail is PiLoginSupport.Line.Done && !fail.ok && fail.error == "denied")
        val cancel = classify("""{"t":"done","ok":false,"cancelled":true}""")
        assertTrue(cancel is PiLoginSupport.Line.Done && cancel.cancelled)
    }

    @Test
    fun `log and unparsable lines never throw`() {
        assertTrue(classify("""{"t":"log","line":"hint"}""") is PiLoginSupport.Line.Log)
        assertTrue(classify("EADDRINUSE: port 1455 in use") is PiLoginSupport.Line.Unknown)
        assertTrue(classify("""{"t":"wat"}""") is PiLoginSupport.Line.Unknown)
        assertTrue(classify("") is PiLoginSupport.Line.Unknown)
        // A prompt without an id (future/foreign helper) degrades, never crashes.
        assertTrue(classify("""{"t":"prompt","p":{}}""") is PiLoginSupport.Line.Unknown)
    }

    @Test
    fun `helper script ships as a plugin resource`() {
        // Extraction needs the config dir; the resource lookup alone is testable.
        val stream = PiLoginSupport::class.java.classLoader.getResourceAsStream("pi-login/pi-login.mjs")
        assertNotNull(stream, "pi-login/pi-login.mjs must ship in the plugin jar")
        val head = stream.bufferedReader(Charsets.UTF_8).readLine()
        assertTrue(head.contains("pi-login.mjs"), "unexpected resource head: $head")
    }
}
