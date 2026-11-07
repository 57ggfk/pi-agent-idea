package dev.pi.agent.process

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Process output charset handling. Native Windows tools print in the local
 * code page, pi/node print UTF-8; decoding both with the JVM default (UTF-8
 * since JDK 18) is what turned a Chinese install path into `????` and a
 * perfectly good pi installation into "Cannot run program".
 */
class OsProcessTest {

    @Test
    fun `keeps UTF-8 output from pi intact`() {
        val text = "pi 1.4.0 — 中文输出正常"
        assertEquals(text, OsProcess.decodeOutput(text.toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun `decodes a path printed by a native tool in the local code page`() {
        val charset = OsProcess.nativeCharset
        val path = "D:\\软件\\nodejs\\pi.cmd"
        if (!charset.newEncoder().canEncode(path)) return // e.g. a Latin-1 host
        assertEquals(path, OsProcess.decodeOutput(path.toByteArray(charset)))
    }

    @Test
    fun `ascii output is unaffected`() {
        val path = "C:\\Users\\dev\\AppData\\Roaming\\npm\\pi.cmd"
        assertEquals(path, OsProcess.decodeOutput(path.toByteArray(Charsets.US_ASCII)))
    }

    @Test
    fun `empty output decodes to empty string`() {
        assertEquals("", OsProcess.decodeOutput(ByteArray(0)))
    }

    // -- 011 T019: both directions, host-independent ---------------------------

    @Test
    fun `utf-8 emoji from the node side survives`() {
        val text = "更新完成 ✅ pi 1.5.0"
        assertEquals(text, OsProcess.decodeOutput(text.toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun `gbk bytes with a chinese install path decode via the fallback charset`() {
        // Windows native tools print CP936; the fallback is injectable so the
        // branch is exercised on a UTF-8 development host too.
        val path = "D:\\软件\\nodejs\\pi.cmd"
        val gbk = path.toByteArray(charset("GBK"))
        assertEquals(path, OsProcess.decodeOutput(gbk, fallback = charset("GBK")))
    }

    @Test
    fun `misdecoded latin-1 input never produces question marks`() {
        // `Ã©` is what UTF-8 bytes look like when shown as Latin-1; decoding
        // those bytes strictly as UTF-8 yields the original é, never `?`.
        val utf8 = "café".toByteArray(Charsets.UTF_8)
        assertEquals("café", OsProcess.decodeOutput(utf8, fallback = charset("ISO-8859-1")))
        val output = OsProcess.decodeOutput(utf8, fallback = Charsets.US_ASCII)
        assertTrue('?' !in output, "no literal ? expected: $output")
    }

    @Test
    fun `crlf and nul bytes survive decoding`() {
        val bytes = "a\r\nb\rc\u0000d".toByteArray(Charsets.UTF_8)
        // decodeOutput is charset-only: line endings are drainThread's job
        assertEquals("a\r\nb\rc\u0000d", OsProcess.decodeOutput(bytes))
    }

    @Test
    fun `one long line without newlines decodes completely`() {
        val text = "x".repeat(300_000)
        assertEquals(text, OsProcess.decodeOutput(text.toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun `windows shell is an absolute path, never the bare name`() {
        if (!OsProcess.isWindows) return
        val shell = OsProcess.windowsShell
        // A bare `cmd` is resolved against the IDE process's own search path;
        // when that lands on a non-executable file CreateProcess answers
        // "error=193, %1 is not a valid Win32 application" and pi looks broken.
        assertTrue(File(shell).isAbsolute, "expected an absolute path, got $shell")
        assertTrue(shell.lowercase().endsWith("cmd.exe"), "expected cmd.exe, got $shell")
    }
}
