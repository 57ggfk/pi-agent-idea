package dev.pi.agent.rpc

import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class LfLineReaderTest {

    private fun reader(data: String) = LfLineReader(ByteArrayInputStream(data.toByteArray(StandardCharsets.UTF_8)))

    @Test
    fun `splits on LF`() {
        reader("{\"a\":1}\n{\"b\":2}\n").use { r ->
            assertEquals("{\"a\":1}", r.readLine())
            assertEquals("{\"b\":2}", r.readLine())
            assertNull(r.readLine())
        }
    }

    @Test
    fun `strips optional CR`() {
        reader("line1\r\nline2\n").use { r ->
            assertEquals("line1", r.readLine())
            assertEquals("line2", r.readLine())
        }
    }

    @Test
    fun `returns final unterminated line`() {
        reader("no-newline-at-end").use { r ->
            assertEquals("no-newline-at-end", r.readLine())
            assertNull(r.readLine())
        }
    }

    @Test
    fun `unicode line separators do not split records`() {
        // U+2028 and U+2029 inside a JSON string must stay within one record.
        val payload = "{\"text\":\"a\\u2028b\\u2029c\"}"
        reader(payload + "\nsecond\n").use { r ->
            assertEquals(payload, r.readLine())
            assertEquals("second", r.readLine())
        }
    }

    @Test
    fun `raw multibyte utf8 with embedded separators stays intact`() {
        val text = "表情\ud83d\ude00separatornext"
        val json = "{\"t\":\"$text\"}\n"
        reader(json).use { r ->
            assertEquals("{\"t\":\"$text\"}", r.readLine())
        }
    }

    @Test
    fun `splits across buffer boundaries`() {
        // Longer than the 64KB internal buffer to force refills.
        val long = "x".repeat(200_000)
        reader("$long\nend\n").use { r ->
            assertEquals(long, r.readLine())
            assertEquals("end", r.readLine())
        }
    }

    @Test
    fun `empty lines are preserved as empty strings`() {
        reader("\n\n").use { r ->
            assertEquals("", r.readLine())
            assertEquals("", r.readLine())
            assertNull(r.readLine())
        }
    }

    @Test
    fun `realistic rpc records parse after framing`() {
        val line1 = """{"id":"req-1","type":"response","command":"get_state","success":true,"data":{"model":{"id":"mimo"}}}"""
        val line2 = """{"type":"agent_settled","aborted":false}"""
        reader("$line1\n$line2\n").use { r ->
            assertEquals(line1, r.readLine())
            assertEquals(line2, r.readLine())
        }
    }
}
