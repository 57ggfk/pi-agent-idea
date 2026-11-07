package dev.pi.agent.process

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 011 T020: the CLI text that reaches a result banner is terminal-visible
 * text only. Pure ASCII must survive byte-identically; escapes, progress
 * frames and backspaces go; Chinese and `[` are never touched.
 */
class CliTextTest {

    private val ESC = "\u001B"

    // -- sanitizeCliOutput ----------------------------------------------------

    @Test
    fun `plain ascii passes through byte-identical`() {
        val text = "updated @example/pi-tools to 1.1.0\nline two [ok]\n"
        assertEquals(text, CliText.sanitizeCliOutput(text))
    }

    @Test
    fun `chinese and brackets are never touched`() {
        val text = "安装完成 [1/3]，路径 D:\\软件\\nodejs\n全部就绪"
        assertEquals(text, CliText.sanitizeCliOutput(text))
    }

    @Test
    fun `csi color sequences are stripped`() {
        assertEquals("green plain", CliText.sanitizeCliOutput("${ESC}[32mgreen${ESC}[0m plain"))
        assertEquals("bold!", CliText.sanitizeCliOutput("${ESC}[1;32;40mbold!${ESC}[m"))
    }

    @Test
    fun `osc title sequences are stripped`() {
        assertEquals("output", CliText.sanitizeCliOutput("${ESC}]0;window title\u0007output"))
        assertEquals("output", CliText.sanitizeCliOutput("${ESC}]8;;http://x${ESC}\\output"))
    }

    @Test
    fun `carriage-return progress bars leave the final frame`() {
        assertEquals("done", CliText.sanitizeCliOutput("10%\r50%\rdone"))
        // per line: earlier lines keep their own final frames
        assertEquals("100%\nsecond done", CliText.sanitizeCliOutput("10%\r100%\nworking\rsecond done"))
    }

    @Test
    fun `trailing carriage return clears the line like a terminal`() {
        assertEquals("", CliText.sanitizeCliOutput("loading...\r"))
    }

    @Test
    fun `backspace deletes the character before it`() {
        assertEquals("aX", CliText.sanitizeCliOutput("abc\b\bX"))
        assertEquals("ok", CliText.sanitizeCliOutput("okx\b"))
    }

    @Test
    fun `newline structure survives sanitizing`() {
        assertEquals("a\nb\nc", CliText.sanitizeCliOutput("a\nb\nc"))
    }

    // -- safeTruncate ----------------------------------------------------------

    @Test
    fun `text at or under the limit is returned unchanged`() {
        val text = "x".repeat(2000)
        assertEquals(text, CliText.safeTruncate(text, 2000))
        assertEquals("short", CliText.safeTruncate("short", 2000))
    }

    @Test
    fun `overlong ascii text is cut at the limit with the marker`() {
        val out = CliText.safeTruncate("a".repeat(3000), 2000)
        assertEquals(2001, out.length)
        assertTrue(out.endsWith("…"))
        assertEquals("a".repeat(2000) + "…", out)
    }

    @Test
    fun `cjk counts as one code point per character`() {
        val text = "中".repeat(2500)
        val out = CliText.safeTruncate(text, 2000)
        assertEquals(2001, out.codePointCount(0, out.length))
        assertEquals("中".repeat(2000) + "…", out)
    }

    @Test
    fun `an emoji half at the cut point is not split into a lone surrogate`() {
        // 1999 ascii + 1 emoji (2 UTF-16 units): the emoji is code point 2000,
        // the cut lands exactly between the complete emoji and the marker.
        val text = "a".repeat(1999) + "\uD83D\uDE00" + "b".repeat(100)
        val out = CliText.safeTruncate(text, 2000)
        assertEquals("a".repeat(1999) + "\uD83D\uDE00…", out)
        // the emoji itself never loses its low surrogate
        assertTrue(!out.endsWith("\uD83D"))
    }

    @Test
    fun `emoji cut in the middle keeps the high surrogate out`() {
        val text = "\uD83D\uDE00".repeat(10) // 10 emoji = 20 units, 10 code points
        assertEquals("\uD83D\uDE00".repeat(3) + "…", CliText.safeTruncate(text, 3))
    }

    @Test
    fun `zero limit truncates to empty`() {
        assertEquals("", CliText.safeTruncate("anything", 0))
    }
}
