package dev.pi.agent.browser

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * Loopback dev-server discovery for the agent's pi_browser tool (F-214,
 * spec 061 竞品缺口 B 的 Cursor-2.0-style "dev-server awareness"): the agent
 * calls `open` without a URL and the probe finds the running local server.
 *
 * Two pure, unit-tested halves plus an IO shell:
 *  - [parseListeningPorts] — `netstat -ano` (Windows) / `ss -ltn` (Linux) /
 *    `lsof -nP -iTCP -sTCP:LISTEN` (macOS) output → LISTEN ports bound to the
 *    loopback interface only;
 *  - [looksLikeHtml] — probe answer classifier (HTTP 200 + HTML-ish body);
 *  - [detect] — enumerate, exclude the plugin's own UI-server port, probe the
 *    candidates with a hard total budget, return the first HTML responder.
 *
 * Safety posture: loopback only, GET / only, no credentials injected, the
 * chat SPA's own port excluded. A wrong explicit URL still fails through the
 * normal failed path — auto-detect is strictly additive.
 */
object DevServerProbe {

    data class ProbeResult(
        /** `http://127.0.0.1:<port>/` of the first HTML responder, or null. */
        val detected: String?,
        /** Loopback ports that were enumerated (post-exclusion, probe order). */
        val candidates: List<Int>,
    )

    /** Connect timeout per candidate; the total budget caps the whole sweep. */
    private const val CONNECT_TIMEOUT_MS = 300L

    /** F-214 round 2: netstat raced a 3s timeout on the real machine (busy TCP tables) — 10s. */
    private const val NETSTAT_TIMEOUT_S = 10L
    private const val TOTAL_BUDGET_MS = 2_500L

    /** Loopback hosts that count as "this machine, reachable from here". */
    private fun isLoopbackHost(host: String): Boolean {
        val h = host.removePrefix("[").removeSuffix("]")
        return h == "::1" || h == "localhost" || h.startsWith("127.")
    }

    /**
     * Parses LISTEN ports from netstat/ss/lsof output. Format-agnostic: any
     * line containing a LISTEN(ING) state whose first `host:port` token is
     * loopback-bound contributes the port. Wildcard binds (0.0.0.0/[::]) are
     * ignored on purpose — auto-detect stays quiet on shared hosts. UDP and
     * header lines carry no LISTEN state (or no loopback address) and drop
     * out naturally.
     */
    fun parseListeningPorts(raw: String): List<Int> {
        // host:port token; the 1..65535 range check below is what rejects
        // fragments of longer tokens (a lookbehind here could never pass —
        // the character before the current position is the port's own digit).
        val addrPort = Regex("\\[?([0-9a-fA-F.:]+|[A-Za-z_-]+)]?:(\\d{1,5})")
        val ports = linkedSetOf<Int>()
        for (line in raw.lineSequence()) {
            if (!line.contains("LISTEN", ignoreCase = true)) continue
            val match = addrPort.find(line) ?: continue
            val host = match.groupValues[1]
            val port = match.groupValues[2].toIntOrNull() ?: continue
            if (port !in 1..65535) continue
            if (isLoopbackHost(host)) ports.add(port)
        }
        return ports.toList().sorted()
    }

    /** True when the probe answer is a usable web page: HTTP 200 + HTML-ish body. */
    fun looksLikeHtml(status: Int, body: String): Boolean {
        if (status != 200) return false
        val head = body.trimStart().take(200).lowercase()
        return head.startsWith("<!doctype") || head.startsWith("<html") ||
            head.contains("<!doctype") || head.contains("<html")
    }

    /**
     * F-214 round 5: common dev-server ports probed FIRST (Cursor-style
     * heuristic - connect-refused fails in milliseconds, so a miss costs
     * almost nothing). The netstat sweep only runs if the heuristic missed,
     * because spawning netstat from the IDE process context hangs past any
     * watchdog on this machine (Java-reproduced: the same read-first spawn
     * completes in 2.5s OUTSIDE the IDE - the hang is IDE-context specific,
     * mechanism unidentified after 4 rounds).
     */
    internal val HEURISTIC_PORTS = listOf(
        3000, 3001, 4200, 5000, 5173, 5174, 8000, 8001, 8080, 8081,
        8888, 8931, 9000, 9090,
    )

    /**
     * Heuristic-first sweep: common dev ports, then the netstat listener
     * enumeration (minus [excludePorts]) if the budget remains. Returns the
     * first HTML responder. [command]/[probe] injectable for tests.
     */
    fun detect(
        excludePorts: Set<Int> = emptySet(),
        command: (String) -> String? = ::runCommand,
        probe: (Int) -> Pair<Int, String>? = ::probeRoot,
    ): ProbeResult {
        val deadline = System.currentTimeMillis() + TOTAL_BUDGET_MS
        for (port in HEURISTIC_PORTS.filter { it !in excludePorts }) {
            if (System.currentTimeMillis() > deadline) break
            val (status, body) = probe(port) ?: continue
            if (looksLikeHtml(status, body)) {
                return ProbeResult("http://127.0.0.1:$port/", listOf(port))
            }
        }
        val ports = command("detect listening ports")?.let { parseListeningPorts(it) }.orEmpty()
            .filter { it !in excludePorts }
            .filter { it !in UNPROBEABLE_PORTS }
        for (port in ports) {
            if (System.currentTimeMillis() > deadline) break
            val (status, body) = probe(port) ?: continue
            if (looksLikeHtml(status, body)) {
                return ProbeResult("http://127.0.0.1:$port/", ports)
            }
        }
        return ProbeResult(null, ports)
    }

    /**
     * Ports that never host a dev UI and would only burn the probe budget
     * (Windows RPC/loopback services, the platform debugger and built-in
     * web-server ports are pure noise).
     */
    private val UNPROBEABLE_PORTS = setOf(135, 445, 5040, 9222, 63342)

    private fun runCommand(@Suppress("unused") command: String): String? = try {
        val windows = System.getProperty("os.name", "").lowercase().contains("win")
        // F-214 round 3: spawn netstat DIRECTLY. The cmd /c wrapper hung the
        // whole 10s budget when spawned from the IDE process (GUI process +
        // console layer), while the same netstat completes in ~1s from a
        // shell. netstat.exe lives in System32 - always on PATH.
        val process = if (windows) {
            ProcessBuilder("netstat", "-ano")
        } else {
            val os = System.getProperty("os.name", "").lowercase()
            if (os.contains("mac")) ProcessBuilder("sh", "-c", "lsof -nP -iTCP -sTCP:LISTEN")
            else ProcessBuilder("sh", "-c", "ss -ltn")
        }.redirectErrorStream(true).start()
        // F-214 round 4 (REAL root cause): waitFor BEFORE reading the output
        // deadlocks - netstat's output exceeded the pipe buffer, the process
        // blocked on writing while this thread blocked on waitFor, the 10s
        // timeout destroyed it, and the parse got EMPTY output ("nothing
        // listening" with the server demonstrably up). Read the stream to EOF
        // first (unblocks the writer), with a watchdog destroying the process
        // past the budget.
        val watchdog = java.util.Timer("netstat-watchdog", true)
        watchdog.schedule(object : java.util.TimerTask() {
            override fun run() {
                process.destroyForcibly()
            }
        }, NETSTAT_TIMEOUT_S * 1000L)
        val raw = process.inputStream.bufferedReader().readText()
        watchdog.cancel()
        raw
    } catch (_: Exception) {
        null
    }

    private fun probeRoot(port: Int): Pair<Int, String>? = try {
        val client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(CONNECT_TIMEOUT_MS))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build()
        val request = HttpRequest.newBuilder()
            .uri(URI.create("http://127.0.0.1:$port/"))
            .timeout(Duration.ofMillis(CONNECT_TIMEOUT_MS))
            .GET()
            .build()
        val response = client.send(request, HttpResponse.BodyHandlers.ofString())
        response.statusCode() to (response.body() ?: "")
    } catch (_: Exception) {
        null
    }
}
