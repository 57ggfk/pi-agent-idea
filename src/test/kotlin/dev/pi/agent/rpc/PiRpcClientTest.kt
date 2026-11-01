package dev.pi.agent.rpc

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Integration test against the node mock-pi implementation, proving the
 * client speaks the real JSONL framing end-to-end.
 */
class PiRpcClientTest {

    private val json = Json
    private val isWindows: Boolean =
        System.getProperty("os.name")?.lowercase()?.contains("windows") == true
    private var client: PiRpcClient? = null
    private var process: Process? = null

    private val events = java.util.concurrent.ConcurrentLinkedQueue<JsonObject>()

    @AfterTest
    fun tearDown() {
        client?.close()
        process?.destroyForcibly()
    }

    private fun startClient(vararg extraEnv: Pair<String, String>): PiRpcClient {
        val mock: File? = sequenceOf("test/mock-pi/mock-pi.mjs", "../test/mock-pi/mock-pi.mjs")
            .map { File(it).absoluteFile }
            .firstOrNull { it.isFile }
        assumeTrue(mock != null && mock.isFile, "mock-pi.mjs not found")
        val mockFile = mock!!
        val node = nodeExecutable()
        assumeTrue(node != null, "node not available")

        val pb = ProcessBuilder(listOf(node, mockFile.absolutePath, "--mode", "rpc"))
        pb.redirectErrorStream(false)
        extraEnv.forEach { (k, v) -> pb.environment()[k] = v }
        val proc = pb.start()
        process = proc

        val c = PiRpcClient(proc, object : PiRpcListener {
            override fun onEvent(event: JsonObject) {
                events.add(event)
            }

            override fun onClosed(message: String) {}
        })
        client = c
        return c
    }

    private fun nodeExecutable(): String? {
        // /usr/bin/env is the nvm-less Unix fallback; on Windows (and any
        // machine with node on PATH) a bare `node` probe works everywhere —
        // CreateProcess finds node.exe, Unix PATH lookup finds the shim.
        val probes = if (isWindows) {
            listOf(listOf("node", "--version"))
        } else {
            listOf(listOf("/usr/bin/env", "node", "--version"), listOf("node", "--version"))
        }
        for (probe in probes) {
            try {
                val proc = ProcessBuilder(probe).start()
                if (proc.waitFor(5, TimeUnit.SECONDS) && proc.exitValue() == 0) return "node"
            } catch (_: Exception) {
            }
        }
        return null
    }

    private fun JsonObject.field(name: String): String = this[name]!!.jsonPrimitive.content

    @Test
    fun `correlates response by id`() {
        val c = startClient()
        val response = c.send(json.parseToJsonElement("""{"type":"get_state"}""").let { it as JsonObject })
            .get(15, TimeUnit.SECONDS)
        assertTrue(response.success)
        assertEquals("get_state", response.command)
        assertTrue(response.data.toString().contains("mock-model-pro"))
    }

    @Test
    fun `prompt streams events then settles`() {
        val c = startClient("MOCK_PI_SPEED" to "0")
        val promptResponse = c.send(json.parseToJsonElement("""{"type":"prompt","message":"hello"}""") as JsonObject)
            .get(15, TimeUnit.SECONDS)
        assertTrue(promptResponse.success)
        assertEquals("started", promptResponse.data.toString().let { Json.parseToJsonElement(it).jsonObject["disposition"]!!.jsonPrimitive.content })

        // Wait for agent_settled
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            if (events.any { it.fieldOrNull("type") == "agent_settled" }) break
            Thread.sleep(50)
        }
        val types = events.map { it["type"]?.jsonPrimitive?.content }
        assertTrue(types.contains("agent_start"))
        assertTrue(types.contains("message_update"))
        assertTrue(types.contains("tool_execution_start"))
        assertTrue(types.contains("tool_execution_end"))
        assertTrue(types.contains("agent_settled"))
    }

    @Test
    fun `concurrent commands correlate independently`() {
        val c = startClient()
        val f1 = c.send(json.parseToJsonElement("""{"type":"get_state"}""") as JsonObject)
        val f2 = c.send(json.parseToJsonElement("""{"type":"get_available_models"}""") as JsonObject)
        val r2 = f2.get(15, TimeUnit.SECONDS)
        val r1 = f1.get(15, TimeUnit.SECONDS)
        assertEquals("get_state", r1.command)
        assertEquals("get_available_models", r2.command)
        assertTrue(r1.success && r2.success)
    }

    @Test
    fun `abort during streaming settles with aborted true`() {
        val c = startClient()
        c.send(json.parseToJsonElement("""{"type":"prompt","message":"long task"}""") as JsonObject)
            .get(15, TimeUnit.SECONDS)
        Thread.sleep(300)
        val abortResponse = c.send(json.parseToJsonElement("""{"type":"abort"}""") as JsonObject)
            .get(15, TimeUnit.SECONDS)
        assertTrue(abortResponse.success)

        val deadline = System.currentTimeMillis() + 20_000
        var settled: JsonObject? = null
        while (System.currentTimeMillis() < deadline) {
            settled = events.firstOrNull { it.fieldOrNull("type") == "agent_settled" }
            if (settled != null) break
            Thread.sleep(50)
        }
        assertTrue(settled != null)
        assertEquals("true", settled!!["aborted"]!!.jsonPrimitive.content)
    }

    @Test
    fun `closing stdin shuts down orderly`() {
        val c = startClient()
        c.send(json.parseToJsonElement("""{"type":"get_state"}""") as JsonObject).get(15, TimeUnit.SECONDS)
        c.close()
        val deadline = System.currentTimeMillis() + 10_000
        while (process!!.isAlive && System.currentTimeMillis() < deadline) Thread.sleep(50)
        assertFalse(process!!.isAlive)
    }

    /** A process that reads and writes nothing for ~30s (pipe-hang scenarios). */
    private fun silentProcess(): ProcessBuilder =
        if (isWindows) ProcessBuilder("powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 30")
        else ProcessBuilder("/bin/sh", "-c", "sleep 30")

    /**
     * Kills the process tree and waits for death: an orphaned grandchild
     * (dash execs the last command, but shells that fork keep sleep alive)
     * holds the stdout pipe open, leaving the client's reader thread parked
     * past the platform leak tracker's check.
     */
    private fun killTree(proc: Process) {
        runCatching { proc.toHandle().descendants().forEach { it.destroyForcibly() } }
        proc.destroyForcibly()
        proc.waitFor(5, TimeUnit.SECONDS)
    }

    @Test
    fun `send times out when pi never responds`() {
        // A process that reads nothing and writes nothing: the command is
        // written to the pipe but never answered.
        val proc = silentProcess().start()
        process = proc
        val c = PiRpcClient(proc, object : PiRpcListener {
            override fun onEvent(event: JsonObject) {}
            override fun onClosed(message: String) {}
        })
        client = c

        val start = System.currentTimeMillis()
        val ex = assertFailsWith<java.util.concurrent.ExecutionException> {
            c.send(
                json.parseToJsonElement("""{"type":"get_state"}""") as JsonObject,
                timeoutMs = 500,
            ).get(10, TimeUnit.SECONDS)
        }
        assertTrue(ex.cause is java.util.concurrent.TimeoutException, "cause: ${ex.cause}")
        // Fails at the 500ms deadline, not at future.get's 10s bound.
        assertTrue(System.currentTimeMillis() - start < 5_000, "timeout should fire at the configured deadline")
        // Kill in-test: the platform leak tracker runs before @AfterTest, and
        // the client's reader thread only unwinds once the process tree dies.
        killTree(proc)
    }

    @Test
    fun `response within timeout completes normally`() {
        val proc = silentProcess().start()
        process = proc
        val c = PiRpcClient(proc, object : PiRpcListener {
            override fun onEvent(event: JsonObject) {}
            override fun onClosed(message: String) {}
        })
        client = c
        val future = c.send(
            json.parseToJsonElement("""{"type":"get_state"}""") as JsonObject,
            timeoutMs = 60_000,
        )
        // No response will ever come; a 1s wait cap fires (as TimeoutException)
        // well below the client-side 60s deadline, proving the deadline has not.
        try {
            future.get(1, TimeUnit.SECONDS)
        } catch (_: java.util.concurrent.TimeoutException) {
            // our wait cap; expected
        }
        // The client-side timeout must NOT have fired yet: the future is still
        // pending, so a fresh wait attempt is legal.
        assertFalse(future.isDone)
        c.close()
        // Same leak-tracker ordering as above: end the process tree here, not
        // in @AfterTest.
        killTree(proc)
    }

    private fun JsonObject.fieldOrNull(name: String): String? =
        (this[name] as? kotlinx.serialization.json.JsonPrimitive)?.content
}
