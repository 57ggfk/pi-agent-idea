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
import kotlin.test.assertTrue

/**
 * Integration test against the node mock-pi implementation, proving the
 * client speaks the real JSONL framing end-to-end.
 */
class PiRpcClientTest {

    private val json = Json
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
        for (candidate in listOf("/usr/bin/env")) {
            try {
                val proc = ProcessBuilder(candidate, "node", "--version").start()
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

    private fun JsonObject.fieldOrNull(name: String): String? =
        (this[name] as? kotlinx.serialization.json.JsonPrimitive)?.content
}
