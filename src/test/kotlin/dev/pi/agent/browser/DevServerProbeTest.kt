package dev.pi.agent.browser

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.Test

/**
 * F-214: the probe's parsing/classification halves are pure and locked here;
 * the IO shell (netstat/ss/lsof + HTTP) is deliberately not unit-tested.
 */
class DevServerProbeTest {

    @Test
    fun `windows netstat loopback listeners are parsed`() {
        val netstat = """
            Active Connections
          Proto  Local Address          Foreign Address        State
          TCP    127.0.0.1:8931         0.0.0.0:0              LISTENING       1234
          TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       888
          TCP    [::]:445               [::]:0                 LISTENING       4
          TCP    127.0.0.1:5173         127.0.0.1:5173         ESTABLISHED     99
          UDP    127.0.0.1:5353         *:*
          TCP    [::1]:3000             [::]:0                 LISTENING       55
        """.trimIndent()
        // Only LISTENING loopback rows count: the wildcard binds (135/445),
        // the ESTABLISHED row and the UDP row all drop out.
        assertEquals(listOf(3000, 8931), DevServerProbe.parseListeningPorts(netstat))
    }

    @Test
    fun `linux ss and macos lsof shapes parse`() {
        val ss = """
            State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port
            LISTEN 0       128     127.0.0.1:8080      0.0.0.0:*
            LISTEN 0       128     0.0.0.0:22          0.0.0.0:*
        """.trimIndent()
        assertEquals(listOf(8080), DevServerProbe.parseListeningPorts(ss))

        val lsof = """
            COMMAND   PID USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME
            node    48211  dev   23u  IPv4  0x1234      0t0  TCP 127.0.0.1:3000 (LISTEN)
        """.trimIndent()
        assertEquals(listOf(3000), DevServerProbe.parseListeningPorts(lsof))
    }

    @Test
    fun `garbage input yields no ports`() {
        assertTrue(DevServerProbe.parseListeningPorts("").isEmpty())
        assertTrue(DevServerProbe.parseListeningPorts("no output at all").isEmpty())
    }

    @Test
    fun `html classifier wants 200 plus markup`() {
        assertTrue(DevServerProbe.looksLikeHtml(200, "<!doctype html><html><body>hi</body>"))
        assertTrue(DevServerProbe.looksLikeHtml(200, "  <HTML><BODY>"))
        assertTrue(DevServerProbe.looksLikeHtml(200, "<html lang=\"en\">"))
        assertFalse(DevServerProbe.looksLikeHtml(404, "<!doctype html>"))
        assertFalse(DevServerProbe.looksLikeHtml(200, "{\"ok\":true}"))
        assertFalse(DevServerProbe.looksLikeHtml(200, ""))
    }

    @Test
    fun `detect returns first html responder and skips excluded ports`() {
        val netstat = """
          TCP    127.0.0.1:135          0.0.0.0:0              LISTENING       888
          TCP    127.0.0.1:9223         0.0.0.0:0              LISTENING       999
          TCP    127.0.0.1:8933         0.0.0.0:0              LISTENING       111
          TCP    127.0.0.1:8931         0.0.0.0:0              LISTENING       222
        """.trimIndent()
        val probed = mutableListOf<Int>()
        val result = DevServerProbe.detect(
            excludePorts = setOf(8933),
            command = { netstat },
            probe = { port ->
                probed.add(port)
                when (port) {
                    8931 -> 200 to "<html><body>dev server</body></html>"
                    else -> 404 to "nope"
                }
            },
        )
        assertEquals("http://127.0.0.1:8931/", result.detected)
        // Two-phase order: the heuristic list runs first (all miss until
        // 8931 answers HTML), and the netstat sweep NEVER runs because the
        // heuristic already found the server (round-5 semantics).
        assertEquals(
            DevServerProbe.HEURISTIC_PORTS.takeWhile { it != 8931 } + 8931,
            probed,
        )
        // netstat-only listeners (RPC noise, excluded ports) never probed.
        assertFalse(135 in probed)
        assertFalse(9223 in probed)
        assertFalse(8933 in probed)
    }

    @Test
    fun `netstat sweep still runs when the heuristic misses`() {
        val netstat = "TCP    127.0.0.1:12345         0.0.0.0:0              LISTENING       7"
        val result = DevServerProbe.detect(
            command = { netstat },
            probe = { port ->
                if (port == 12345) 200 to "<html>on a non-heuristic port</html>" else 404 to "nope"
            },
        )
        assertEquals("http://127.0.0.1:12345/", result.detected)
        // The heuristic phase probed its whole list (all refused), then the
        // sweep found 12345.
        assertTrue(12345 in result.candidates)
    }

    @Test
    fun `detect with no responder returns null with candidates`() {
        val result = DevServerProbe.detect(
            command = { "TCP    127.0.0.1:12345         0.0.0.0:0              LISTENING       1" },
            probe = { null },
        )
        assertNull(result.detected)
        assertEquals(listOf(12345), result.candidates)
    }
}
