package dev.pi.agent.queue

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Spec 005: pi is the queue's source of truth; the service keeps an
 * id/image-bearing mirror and rebuilds pi's queue for every local operation.
 * The RPC sender is a fake, so every test also pins exactly which commands
 * reached pi (clear → re-enqueue, or nothing at all on the edge cases).
 */
class PiMessageQueueTest {

    /** Simulates pi: enqueues land in arrays, clear_queue returns and empties them. */
    private class FakeRpc : (JsonObject) -> JsonObject {
        val commands = mutableListOf<JsonObject>()
        var failNext = false
        /** get_state.isStreaming — false (idle) by default, like a fresh process. */
        var streaming = false
        /** What pi currently holds — steer/follow_up append, clear_queue drains. */
        val piSteering = mutableListOf<String>()
        val piFollowUp = mutableListOf<String>()

        override fun invoke(command: JsonObject): JsonObject {
            if (failNext) {
                failNext = false
                throw RuntimeException("the model endpoint is unavailable")
            }
            commands += command
            when (command["type"]?.jsonPrimitive?.content) {
                "clear_queue" -> {
                    val steering = piSteering.toList()
                    val followUp = piFollowUp.toList()
                    piSteering.clear()
                    piFollowUp.clear()
                    return buildJsonObject {
                        put("steering", JsonArray(steering.map { JsonPrimitive(it) }))
                        put("followUp", JsonArray(followUp.map { JsonPrimitive(it) }))
                    }
                }
                "get_state" -> return buildJsonObject {
                    put("type", "response")
                    put("success", true)
                    put("data", buildJsonObject { put("isStreaming", streaming) })
                }
                "steer" -> piSteering += command["message"]!!.jsonPrimitive.content
                "follow_up" -> piFollowUp += command["message"]!!.jsonPrimitive.content
            }
            return buildJsonObject { put("ok", true) }
        }

        fun types(): List<String> = commands.map { it["type"]?.jsonPrimitive?.content ?: "" }

        fun messages(): List<String> =
            commands.mapNotNull { (it["message"] as? JsonPrimitive)?.content }

        fun clear() = commands.clear()
    }

    private class FakePush : (JsonObject) -> Unit {
        val events = mutableListOf<JsonObject>()
        override fun invoke(event: JsonObject) {
            events.add(event)
        }

        fun lastItems(): List<JsonObject> =
            ((events.last()["items"] as? JsonArray) ?: JsonArray(emptyList())).map { it.jsonObject }

        fun lastFlags(): Triple<Boolean, String?, Boolean> = Triple(
            events.last()["paused"]?.jsonPrimitive?.content == "true",
            (events.last()["pauseReason"] as? JsonPrimitive)?.takeIf { it !is kotlinx.serialization.json.JsonNull }?.content,
            events.last()["drift"]?.jsonPrimitive?.content == "true",
        )
    }

    private val rpc = FakeRpc()
    private val push = FakePush()
    private val queue = PiMessageQueue(rpc, push)

    private fun enqueue(mode: String, vararg texts: String, images: List<String> = emptyList()): List<String> {
        val ids = mutableListOf<String>()
        for (text in texts) {
            val params = buildJsonObject {
                put("mode", mode)
                put("text", text)
                if (images.isNotEmpty()) {
                    put("images", JsonArray(images.map {
                        buildJsonObject { put("data", it); put("mimeType", "image/png") }
                    }))
                }
            }
            val res = queue.handle("enqueue", params)
            assertEquals("true", res["ok"]!!.jsonPrimitive.content, "enqueue $text failed: $res")
            ids += res["id"]!!.jsonPrimitive.content
        }
        rpc.clear()
        return ids
    }

    private fun queueUpdate(steering: List<String>, followUp: List<String>) {
        queue.onPiEvent(buildJsonObject {
            put("type", "queue_update")
            put("steering", JsonArray(steering.map { JsonPrimitive(it) }))
            put("followUp", JsonArray(followUp.map { JsonPrimitive(it) }))
        })
        queue.drain()
    }

    private fun texts(): List<String> = push.lastItems().map { it["text"]!!.jsonPrimitive.content }
    private fun modes(): List<String> = push.lastItems().map { it["mode"]!!.jsonPrimitive.content }
    private fun imagesOf(index: Int): Int =
        ((push.lastItems()[index]["images"] as? JsonArray) ?: JsonArray(emptyList())).size

    // -- snapshot & alignment ---------------------------------------------------

    @Test
    fun `a fresh service reports an empty unpaused snapshot`() {
        val snapshot = queue.handle("get", buildJsonObject { })
        assertEquals("[]", snapshot["items"].toString())
        assertEquals("false", snapshot["paused"]!!.jsonPrimitive.content)
        assertEquals("false", snapshot["drift"]!!.jsonPrimitive.content)
    }

    @Test
    fun `queue_update keeps ids and images when the texts still match`() {
        val ids = enqueue("followUp", "A", images = listOf("img-abc"))
        queueUpdate(emptyList(), listOf("A"))

        assertEquals(listOf("A"), texts())
        assertEquals(ids.single(), push.lastItems().single()["id"]!!.jsonPrimitive.content)
        assertEquals(1, imagesOf(0))
        assertFalse(push.lastFlags().third, "no drift when the mirror matches pi")
    }

    @Test
    fun `queue_update rebuilds from pi without images and flags drift on a mismatch`() {
        enqueue("followUp", "A", "B", images = listOf("img-abc"))
        queueUpdate(emptyList(), listOf("A"))

        assertEquals(listOf("A"), texts())
        assertEquals(0, imagesOf(0), "the image cannot be attributed after pi rewrote the queue")
        assertTrue(push.lastFlags().third)
    }

    @Test
    fun `failed items survive an alignment that rebuilds the queued ones`() {
        rpc.failNext = true
        val res = queue.handle(
            "enqueue",
            buildJsonObject { put("mode", "steer"); put("text", "S") },
        )
        assertEquals("false", res["ok"]!!.jsonPrimitive.content)
        assertEquals("true", res["retained"]!!.jsonPrimitive.content)
        queue.drain()
        rpc.clear()

        queueUpdate(emptyList(), emptyList())
        val items = push.lastItems()
        assertEquals(1, items.size, "the failed entry must stay visible (US5-4)")
        assertEquals("failed", items.single()["status"]!!.jsonPrimitive.content)
        assertTrue(items.single()["error"]!!.jsonPrimitive.content.contains("endpoint"))
    }

    // -- move -------------------------------------------------------------------

    @Test
    fun `move swaps adjacent same-mode items and re-enqueues in the new order`() {
        val ids = enqueue("followUp", "F1", "F2", "F3")

        queue.handle("move", buildJsonObject { put("id", ids[1]); put("delta", -1) })

        assertEquals(listOf("clear_queue", "follow_up", "follow_up", "follow_up"), rpc.types())
        assertEquals(listOf("F2", "F1", "F3"), rpc.messages())
        assertEquals(listOf("F2", "F1", "F3"), texts())
    }

    @Test
    fun `move at the edge refuses without touching pi`() {
        val ids = enqueue("followUp", "F1", "F2")

        val res = queue.handle("move", buildJsonObject { put("id", ids[0]); put("delta", -1) })

        assertEquals("false", res["ok"]!!.jsonPrimitive.content)
        assertEquals("at edge", res["error"]!!.jsonPrimitive.content)
        assertEquals(emptyList(), rpc.types(), "an edge move must not call clear_queue (T016)")
    }

    @Test
    fun `move across the steer and followUp sections is refused`() {
        val steerId = enqueue("steer", "S1").single()
        val followId = enqueue("followUp", "F1").single()
        rpc.clear()

        val res = queue.handle("move", buildJsonObject { put("id", followId); put("delta", -1) })

        assertEquals("at edge", res["error"]!!.jsonPrimitive.content)
        assertEquals(emptyList(), rpc.types())
    }

    @Test
    fun `a mid-operation drift aborts the move and restores pi's own order`() {
        val ids = enqueue("followUp", "F1", "F2")
        // Someone removed F2 in a terminal between our mirror update and now.
        rpc.piFollowUp.remove("F2")

        val res = queue.handle("move", buildJsonObject { put("id", ids[0]); put("delta", +1) })

        assertEquals("false", res["ok"]!!.jsonPrimitive.content)
        assertEquals(listOf("F1"), texts(), "the mirror was rebuilt from pi")
        assertEquals(listOf("F1"), rpc.messages(), "pi's own order was put back")
        assertTrue(push.lastFlags().third)
    }

    // -- remove / restore / promote ----------------------------------------------

    @Test
    fun `restore takes the item out and returns text with images`() {
        val ids = enqueue("followUp", "F1", "F2", images = listOf("img-1"))

        val res = queue.handle("restore", buildJsonObject { put("id", ids[0]) })

        assertEquals("true", res["ok"]!!.jsonPrimitive.content)
        assertEquals("F1", res["text"]!!.jsonPrimitive.content)
        assertEquals(1, (res["images"]!!.jsonArray).size)
        assertEquals(listOf("F2"), texts())
        assertEquals(listOf("clear_queue", "follow_up"), rpc.types())
        assertEquals(listOf("F2"), rpc.messages())
    }

    @Test
    fun `promote re-enqueues the target as steer and the rest as follow-up in order`() {
        val ids = enqueue("followUp", "F1", "F2", "F3")
        // A run is active (tracked from agent_start, not get_state — real pi
        // omits isStreaming there): the steer actually injects.
        queue.onPiEvent(buildJsonObject { put("type", "agent_start") })

        queue.handle("promote", buildJsonObject { put("id", ids[1]) })

        assertEquals(listOf("clear_queue", "steer", "follow_up", "follow_up"), rpc.types())
        assertEquals(listOf("F2", "F1", "F3"), rpc.messages())
        assertEquals(listOf("steer", "followUp", "followUp"), modes())
        assertEquals(listOf("F2", "F1", "F3"), texts())
    }

    @Test
    fun `agent_settled ends the run so promote degrades to a direct send (US6-2)`() {
        val ids = enqueue("followUp", "F1", "F2")
        queue.onPiEvent(buildJsonObject { put("type", "agent_start") })
        queue.onPiEvent(buildJsonObject { put("type", "agent_settled") })
        rpc.clear()

        queue.handle("promote", buildJsonObject { put("id", ids[0]) })

        assertEquals(listOf("prompt"), rpc.types())
        assertEquals(listOf("F1"), rpc.messages())
        assertEquals(listOf("F2"), texts())
    }

    @Test
    fun `promote is a no-op for an already steering item`() {
        val ids = enqueue("steer", "S1")

        queue.handle("promote", buildJsonObject { put("id", ids.single()) })

        assertEquals(emptyList(), rpc.types())
    }

    // -- pause / resume / abort / restart ----------------------------------------

    @Test
    fun `pause empties pi side and keeps the mirror, resume re-enqueues in order`() {
        val ids = enqueue("followUp", "F1", "F2", images = listOf("img-1"))

        queue.handle("pause", buildJsonObject { })
        assertEquals(listOf("clear_queue"), rpc.types())
        val (paused, reason, _) = push.lastFlags()
        assertTrue(paused)
        assertEquals("manual", reason)
        assertEquals(listOf("F1", "F2"), texts(), "the mirror keeps the entries")

        rpc.clear()
        // A run is active: everything re-queues as-is.
        queue.onPiEvent(buildJsonObject { put("type", "agent_start") })
        queue.handle("resume", buildJsonObject { })
        assertEquals(listOf("follow_up", "follow_up"), rpc.types())
        assertEquals(listOf("F1", "F2"), rpc.messages())
        assertFalse(push.lastFlags().first)
    }

    @Test
    fun `resume while idle fires the first entry as a prompt and chains the rest (FR-013)`() {
        enqueue("followUp", "F1", "F2")
        queue.handle("pause", buildJsonObject { })
        rpc.clear()

        // Idle by default (real-pi probe: an idle follow_up never self-starts).
        queue.handle("resume", buildJsonObject { })

        assertEquals(listOf("prompt", "follow_up"), rpc.types())
        assertEquals(listOf("F1", "F2"), rpc.messages())
        assertFalse(push.lastFlags().first)
    }

    @Test
    fun `abort parks the queue and ignores the next queue_update`() {
        enqueue("followUp", "F1", images = listOf("img-1"))

        queue.onAborted()
        queue.drain()
        assertTrue(push.lastFlags().first)
        assertEquals("aborted", push.lastFlags().second)

        // pi reports an empty queue after abort — that must not wipe the mirror.
        queueUpdate(emptyList(), emptyList())
        assertEquals(listOf("F1"), texts())
        assertEquals(1, imagesOf(0))
    }

    @Test
    fun `a restarted pi process parks a non-empty mirror`() {
        enqueue("followUp", "F1")

        queue.onProcessRestarted()
        queue.drain()

        assertTrue(push.lastFlags().first)
        assertEquals("pi-restarted", push.lastFlags().second)
        assertEquals(listOf("F1"), texts())
        assertEquals(emptyList(), rpc.types(), "the fresh process has nothing to clear")
    }

    @Test
    fun `operations on a parked queue work on the mirror without touching pi`() {
        val ids = enqueue("followUp", "F1", "F2", images = listOf("img-1"))
        queue.handle("pause", buildJsonObject { })
        rpc.clear()

        // Reorganize while parked — found by the real-machine pass: the old
        // clear→reconcile path compared against pi's empty queue and wiped
        // the parked entries.
        queue.handle("move", buildJsonObject { put("id", ids[1]); put("delta", -1) })
        assertEquals(listOf("F2", "F1"), texts())

        queue.handle("promote", buildJsonObject { put("id", ids[1]) })
        assertEquals(listOf("steer", "followUp"), modes())

        val restored = queue.handle("restore", buildJsonObject { put("id", ids[0]) })
        assertEquals("true", restored["ok"]!!.jsonPrimitive.content)
        assertEquals("F1", restored["text"]!!.jsonPrimitive.content)
        assertEquals(listOf("F2"), texts())

        assertEquals(emptyList(), rpc.types(), "a parked queue must not touch pi")

        // Resume delivers the reorganized queue; idle → first entry as prompt.
        queue.handle("resume", buildJsonObject { })
        assertEquals(listOf("prompt"), rpc.types())
        assertEquals(listOf("F2"), rpc.messages())
    }

    @Test
    fun `clear wipes mirror and pause state`() {
        enqueue("followUp", "F1")
        queue.handle("pause", buildJsonObject { })
        rpc.clear()

        queue.handle("clear", buildJsonObject { })

        assertEquals(emptyList(), texts())
        assertFalse(push.lastFlags().first)
        assertFalse(push.lastFlags().third)
    }
}
