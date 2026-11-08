package dev.pi.agent.bridge

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 013 US2: `ide.openTerminal` sanitizes the command (one shell line, bounded)
 * before it can reach a shell, and reports which path it took — `typed` (a
 * terminal session got the command) vs the copy fallback. The EDT paths need a
 * running IDE, so the unit suite pins the pure halves: sanitization and the
 * outcome envelope the frontend keys on.
 */
class PiIdeTerminalTest {

    @Test
    fun `sanitize keeps a plain command`() {
        assertEquals("pi", PiIdeTerminal.sanitizeCommand("pi"))
        assertEquals("pi --no-session", PiIdeTerminal.sanitizeCommand("  pi --no-session  "))
    }

    @Test
    fun `sanitize collapses line breaks into spaces`() {
        assertEquals("pi -p hello", PiIdeTerminal.sanitizeCommand("pi -p\r\nhello"))
        assertEquals("pi -p hello", PiIdeTerminal.sanitizeCommand("pi -p\n\nhello"))
    }

    @Test
    fun `sanitize rejects blank and oversized commands`() {
        assertNull(PiIdeTerminal.sanitizeCommand(null))
        assertNull(PiIdeTerminal.sanitizeCommand("   "))
        assertNull(PiIdeTerminal.sanitizeCommand("\n\r"))
        assertNull(PiIdeTerminal.sanitizeCommand("x".repeat(201)))
        assertEquals(200, PiIdeTerminal.sanitizeCommand("x".repeat(200))!!.length)
    }

    @Test
    fun `outcome envelope tells the three paths apart`() {
        val typed = PiIdeTerminal.outcome(ok = true, typed = true, error = null)
        assertTrue(typed["ok"]!!.jsonPrimitive.content.toBoolean())
        assertTrue(typed["typed"]!!.jsonPrimitive.content.toBoolean())
        assertFalse(typed.containsKey("error"))

        val copied = PiIdeTerminal.outcome(ok = true, typed = false, error = null)
        assertTrue(copied["ok"]!!.jsonPrimitive.content.toBoolean())
        assertFalse(copied["typed"]!!.jsonPrimitive.content.toBoolean())

        val failed = PiIdeTerminal.outcome(ok = false, typed = false, error = "terminal unavailable")
        assertFalse(failed["ok"]!!.jsonPrimitive.content.toBoolean())
        assertEquals("terminal unavailable", failed["error"]!!.jsonPrimitive.content)
    }
}
