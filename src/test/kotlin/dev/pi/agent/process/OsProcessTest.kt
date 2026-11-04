package dev.pi.agent.process

import kotlin.test.Test
import kotlin.test.assertEquals

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
}
