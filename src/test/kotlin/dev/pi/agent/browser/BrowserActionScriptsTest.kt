package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * 069 浏览器操作层: the pure script builders for click/type/evaluate and
 * the ActionResult routing behind them. The escaping locks are the heart of
 * this file — quotes, backslashes, newlines, CJK and `</script>`-shaped
 * payloads must stay inert STRING content of the embedded literals, never
 * executable code (same bar as the 061 selector escaping).
 */
class BrowserActionScriptsTest {

    private val inject = "window.cefQuery_1({request: '' + result});"

    // ---- click ----

    @Test
    fun `click script queries the element and fires the full mouse sequence`() {
        val script = BrowserActionScripts.buildClickScript(inject, "#btn")
        assertTrue("document.querySelector" in script)
        assertTrue("\"#btn\"" in script)
        // scrollIntoView first so the synthetic click lands on a visible spot.
        assertTrue("scrollIntoView({ block: 'center' })" in script)
        // bubbles:true — closer to a real user event than a bare el.click().
        assertTrue("bubbles: true" in script)
        for (phase in listOf("pointerdown", "mousedown", "mouseup", "'click'")) {
            assertTrue(phase in script, "phase=$phase missing")
        }
        assertTrue("window.PointerEvent || MouseEvent" in script, "pointer events degrade to MouseEvent")
        // The answer reports tag and a bounded text excerpt.
        assertTrue("toLowerCase()" in script)
        assertTrue("slice(0, ${BrowserActionScripts.MAX_ELEMENT_TEXT_CHARS})" in script)
        assertTrue("window.cefQuery_1" in script)
    }

    @Test
    fun `click script reports the miss instead of throwing`() {
        val script = BrowserActionScripts.buildClickScript(inject, "#missing")
        assertTrue("no element matches selector" in script)
        assertTrue("found: false" in script)
    }

    @Test
    fun `click script embeds the selector as an escaped inert literal`() {
        val sneaky = BrowserActionScripts.buildClickScript(inject, """a"; alert(1); p[onclick="x"]""")
        // The quote that would close the literal is escaped, so the payload
        // stays string content of the selector literal.
        assertTrue("""a\"; alert(1); p[onclick=\"x\"]""" in sneaky)
    }

    // ---- type ----

    @Test
    fun `type script focuses and uses the native value setter for inputs`() {
        val script = BrowserActionScripts.buildTypeScript(inject, "#inp", "hello")
        assertTrue("document.querySelector" in script)
        assertTrue("\"#inp\"" in script)
        assertTrue("el.focus()" in script)
        // React compat: the value goes through the prototype setter, then a
        // bubbling input event tells frameworks the value changed.
        assertTrue("Object.getOwnPropertyDescriptor" in script)
        assertTrue("HTMLInputElement.prototype" in script)
        assertTrue("HTMLTextAreaElement.prototype" in script)
        assertTrue("new Event('input', { bubbles: true })" in script)
        assertTrue("\"hello\"" in script)
        assertTrue("typed: value.length" in script)
    }

    @Test
    fun `type script routes contenteditable through execCommand insertText`() {
        val script = BrowserActionScripts.buildTypeScript(inject, "[contenteditable]", "你好")
        assertTrue("isContentEditable" in script)
        assertTrue("execCommand('selectAll'" in script)
        assertTrue("execCommand('insertText'" in script)
        // CJK text rides the literal unchanged.
        assertTrue("\"你好\"" in script)
    }

    @Test
    fun `type script escapes quotes backslashes newlines and script-close payloads`() {
        val hostile = "x\"; alert(1); \\ y\nz</script> 你好"
        val script = BrowserActionScripts.buildTypeScript(inject, "#inp", hostile)
        // The double quote is escaped → the string literal never closes early:
        // the raw `x";` sequence (quote straight after x) must NOT exist.
        assertTrue("""x\"; alert(1);""" in script)
        assertFalse("x\"; alert" in script)
        // The backslash itself is doubled.
        assertTrue("\\\\ y" in script)
        // The newline is the two-character escape, never a raw line break
        // inside the literal; `</script>` stays inert string content; CJK passes.
        assertTrue("\\nz</script> 你好" in script)
    }

    // ---- evaluate ----

    @Test
    fun `evaluate script wraps the user js in eval and stringifies the result`() {
        val script = BrowserActionScripts.buildEvaluateScript(inject, "document.title")
        assertTrue("return eval(" in script, "completion-value semantics: the user expression's value comes back")
        assertTrue("\"document.title\"" in script)
        assertTrue("JSON.stringify(ret)" in script)
        // undefined (and stringify-throws) degrade to a string, never drop the field.
        assertTrue("'undefined'" in script)
        assertTrue("unserializable: " in script)
        assertTrue("ok: true" in script)
    }

    @Test
    fun `evaluate script catches page-side throws as ok-false error`() {
        val script = BrowserActionScripts.buildEvaluateScript(inject, "boom()")
        assertTrue("ok: false" in script)
        assertTrue("String((e && e.message) || e)" in script)
    }

    @Test
    fun `evaluate script embeds the js as an escaped inert literal`() {
        // The code rides a DOUBLE-quoted string literal into eval(): single
        // quotes are inert inside it; the escape that matters is the double
        // quote, whose escaping is what stops the payload leaving the literal.
        val sneaky = BrowserActionScripts.buildEvaluateScript(inject, "1\"); alert('pwned'); (\"")
        // The double quote is escaped (`1\")`) → the literal never closes early.
        assertTrue("1\\\")" in sneaky, "payload=$sneaky")
        assertFalse("1\")" in sneaky, "the raw breakout sequence must not exist")
        // Single quotes survive verbatim as string content (eval may throw on
        // them — that degrades to ok:false + error, never an injection).
        assertTrue("alert('pwned')" in sneaky)
    }

    @Test
    fun `evaluate caps the page-side value before it rides the channel`() {
        val script = BrowserActionScripts.buildEvaluateScript(inject, "document.title")
        assertTrue("slice(0, ${BrowserActionScripts.MAX_EVALUATE_VALUE_CHARS})" in script)
    }

    // ---- shared escaping vocabulary (locked against every destroyer) ----

    @Test
    fun `js string literal escaping locks the destroyer set`() {
        assertEquals("\"plain\"", PageSnapshotSanitizer.jsString("plain"))
        assertEquals("\"a\\\"b\"", PageSnapshotSanitizer.jsString("a\"b")) // quote
        assertEquals("\"a\\\\b\"", PageSnapshotSanitizer.jsString("a\\b")) // backslash
        assertEquals("\"a\\nb\"", PageSnapshotSanitizer.jsString("a\nb")) // newline
        assertEquals("\"a\\rb\"", PageSnapshotSanitizer.jsString("a\rb")) // carriage return
        assertEquals("\"a\\tb\"", PageSnapshotSanitizer.jsString("a\tb")) // tab
        assertEquals("\"你好\"", PageSnapshotSanitizer.jsString("你好")) // CJK passes through
        assertEquals("\"a</script>b\"", PageSnapshotSanitizer.jsString("a</script>b")) // script-close stays literal
        assertEquals("\"a\\u0000b\"", PageSnapshotSanitizer.jsString("a\u0000b")) // C0 control
        assertEquals("\"a\\u0085b\"", PageSnapshotSanitizer.jsString("a\u0085b")) // C1 control
    }

    // ---- ActionResult routing (kernel callback side) ----

    @Test
    fun `click result routes hit tag and text`() {
        // The script lowercases el.tagName before shipping; the parse side is
        // faithful to the wire shape.
        val raw = """{"kind":"action","action":"click","found":true,"tag":"button","text":"Submit order"}"""
        val result = ActionResult.fromJs(raw)
        assertTrue(result.ok)
        assertEquals(true, result.found)
        assertEquals("button", result.tag)
        assertEquals("Submit order", result.text)
    }

    @Test
    fun `click result routes the miss as an ok answer with the reason`() {
        val raw = """{"kind":"action","action":"click","found":false,"error":"no element matches selector: #x"}"""
        val result = ActionResult.fromJs(raw)
        assertTrue(result.ok, "a miss executed cleanly — the page round-trip worked")
        assertEquals(false, result.found)
        assertEquals("no element matches selector: #x", result.reason)
    }

    @Test
    fun `page-side throws become ok-false with reason and the error field`() {
        val click = ActionResult.fromJs("""{"kind":"action","action":"click","ok":false,"error":"SecurityError: blocked"}""")
        assertFalse(click.ok)
        assertEquals("SecurityError: blocked", click.error)
        assertTrue("click failed" in (click.reason ?: ""))

        val eval = ActionResult.fromJs("""{"kind":"action","action":"evaluate","ok":false,"error":"ReferenceError: boom is not defined"}""")
        assertFalse(eval.ok)
        assertEquals("ReferenceError: boom is not defined", eval.error)
        assertTrue("evaluate failed" in (eval.reason ?: ""))
    }

    @Test
    fun `type result routes found and typed count`() {
        val hit = ActionResult.fromJs("""{"kind":"action","action":"type","found":true,"typed":5}""")
        assertTrue(hit.ok)
        assertEquals(true, hit.found)
        assertEquals(5, hit.typed)

        val miss = ActionResult.fromJs("""{"kind":"action","action":"type","found":false,"error":"no element matches selector: #z"}""")
        assertTrue(miss.ok)
        assertEquals(false, miss.found)
        assertEquals("no element matches selector: #z", miss.reason)
    }

    @Test
    fun `evaluate result carries the stringified value cleaned and capped`() {
        val value = "x".repeat(4000) + "\u0000tail"
        // Built through the JSON writer so the NUL is properly escaped on the wire.
        val raw = kotlinx.serialization.json.buildJsonObject {
            put("kind", kotlinx.serialization.json.JsonPrimitive("action"))
            put("action", kotlinx.serialization.json.JsonPrimitive("evaluate"))
            put("ok", kotlinx.serialization.json.JsonPrimitive(true))
            put("value", kotlinx.serialization.json.JsonPrimitive(value))
        }.toString()
        val result = ActionResult.fromJs(raw)
        assertTrue(result.ok)
        assertEquals(PageSnapshotSanitizer.MAX_TEXT_CHARS, result.value?.length, "value is capped like every page text")
        assertFalse(result.value!!.contains('\u0000'))
    }

    @Test
    fun `malformed action responses degrade instead of throwing`() {
        for (raw in listOf(null, "", "not json", """{"kind":"action"}""", """{"kind":"action","action":"wat"}""")) {
            val result = ActionResult.fromJs(raw)
            assertFalse(result.ok, "raw=$raw")
            assertTrue(result.reason != null)
        }
    }

    @Test
    fun `transport failure factories carry the model-readable reason`() {
        assertEquals("browser tab is not open; use open first", ActionResult.noPage().reason)
        assertEquals("browser renderer is down", ActionResult.rendererDown().reason)
        assertEquals("browser is still starting", ActionResult.stillStarting().reason)
        assertEquals("another action is still in flight; retry shortly", ActionResult.inFlight().reason)
        assertEquals("action timed out; the page may still be loading or blocked", ActionResult.timedOut().reason)
        assertEquals("browser closed during action", ActionResult.closed().reason)
    }
}
