package dev.pi.agent.queue

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Mirror of pi's message queue (spec 005).
 *
 * pi is the source of truth: `queue_update` carries the FULL steering/followUp
 * text arrays and `clear_queue` returns them, but neither carries ids or
 * images. This service keeps a mirror with both, aligned against pi by text
 * item-by-item, and implements what pi lacks (move / remove / restore /
 * promote / pause) through the only available primitive:
 * `clear_queue → rebuild → re-enqueue`, atomic on a single-thread executor.
 *
 * Display order is canonical: the steering section (injected during the
 * current run) comes first, then follow-ups (executed after settle). A failed
 * `steer` keeps its item in the mirror marked `failed` — alignment compares
 * only queued items, so the raw error stays visible until the user acts on it.
 */
class PiMessageQueue(
    /** Sends one RPC command to pi; throws on failure. Injectable for tests. */
    private val rpc: (JsonObject) -> JsonObject,
    /** Pushes a queue_state event payload to the frontend. Injectable for tests. */
    private val push: (JsonObject) -> Unit,
) {

    data class Image(val data: String, val mimeType: String)

    data class Item(
        val id: String,
        /** "steer" | "followUp" — pi's own words on the wire. */
        val mode: String,
        val text: String,
        val images: List<Image>,
        val status: String,
        val error: String? = null,
        val createdAt: Long,
    )

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "pi-message-queue").apply { isDaemon = true }
    }
    private val items = mutableListOf<Item>()
    private val idSeq = AtomicLong()

    @Volatile
    private var paused = false

    @Volatile
    private var pauseReason: String? = null

    @Volatile
    private var drift = false

    /**
     * Tracked from pi's own events. get_state cannot answer this: real pi
     * 1.4.0 omits `isStreaming` from the response while streaming (probe
     * 2026-11-04), so asking would always read as idle.
     */
    @Volatile
    private var piStreaming = false

    // -- entry points (called from BridgeService) ------------------------------

    /** Dispatches a `queue.*` bridge method (without the prefix). */
    fun handle(method: String, params: JsonObject): JsonObject {
        val future = executor.submit(Callable {
            when (method) {
                "get" -> snapshotJson()
                "enqueue" -> doEnqueue(params)
                "move" -> doMove(params)
                "remove" -> doRemove(params)
                "restore" -> doRestore(params)
                "promote" -> doPromote(params)
                "pause" -> doPause(params)
                "resume" -> doResume()
                "clear" -> doClear()
                else -> errorJson("unknown queue method: $method")
            }
        })
        return try {
            // Re-enqueueing N items costs N RPCs; updates get 300s, so may this.
            future.get(300, TimeUnit.SECONDS)
        } catch (e: Exception) {
            errorJson("queue $method failed: ${e.cause?.message ?: e.message}")
        }
    }

    /** Consumes pi session events: run-state tracking + `queue_update`. */
    fun onPiEvent(event: JsonObject) {
        when (event["type"]?.jsonPrimitive?.contentOrNull) {
            "agent_start" -> piStreaming = true
            "agent_settled" -> piStreaming = false
            "queue_update" -> {
                val steering = event.stringList("steering")
                val followUp = event.stringList("followUp")
                executor.execute { alignAndPush(steering, followUp) }
            }
        }
    }

    /**
     * A fresh pi process starts with an empty queue: whatever the mirror holds
     * will not run on its own. Park it in the paused state instead of letting
     * the first `queue_update` (empty arrays) silently wipe it.
     */
    fun onProcessRestarted() {
        executor.execute {
            if (items.isEmpty() || paused) return@execute
            paused = true
            pauseReason = "pi-restarted"
            push(snapshotJson())
        }
    }

    /** abort's queue behaviour is undocumented-vs-observed contradictory; the
     *  mirror is the survivor. Empty pi's queue best-effort, keep the items. */
    fun onAborted() {
        executor.execute {
            if (items.isEmpty() || paused) return@execute
            runCatching { rpc(clearQueueCommand()) }
            paused = true
            pauseReason = "aborted"
            push(snapshotJson())
        }
    }

    fun shutdown() {
        executor.shutdownNow()
    }

    /** Waits until all previously submitted work has run (test seam). */
    fun drain() {
        executor.submit(Callable { }).get(5, TimeUnit.SECONDS)
    }

    // -- alignment -------------------------------------------------------------

    private fun alignAndPush(steering: List<String>, followUp: List<String>) {
        if (paused) {
            // The mirror intentionally diverges while paused (pi's queue is
            // empty by design); a stray queue_update must not wipe it.
            push(snapshotJson())
            return
        }
        if (!matchesQueue(items.filter { it.status == "queued" }, steering, followUp)) {
            rebuildFrom(steering, followUp)
            drift = true
        }
        push(snapshotJson())
    }

    /** True when the queued mirror items equal pi's arrays section by section. */
    private fun matchesQueue(queued: List<Item>, steering: List<String>, followUp: List<String>): Boolean {
        val piOrder = steering.map { it to "steer" } + followUp.map { it to "followUp" }
        return queued.size == piOrder.size &&
            queued.zip(piOrder).all { (item, p) -> item.text == p.first && item.mode == p.second }
    }

    /**
     * Rebuilds the mirror from pi's arrays: no images, new ids (identical
     * texts cannot be matched reliably, so guessing would pin images to the
     * wrong item). Failed items survive in place — they are not pi's concern.
     */
    private fun rebuildFrom(steering: List<String>, followUp: List<String>) {
        val piOrder = steering.map { it to "steer" } + followUp.map { it to "followUp" }
        val failed = items.filter { it.status == "failed" }
        val rebuilt = piOrder.map { (text, mode) -> newItem(mode, text, emptyList()) }.toMutableList()
        // Re-insert failed items right after the section they belonged to.
        for (failedItem in failed) {
            val sectionEnd = rebuilt.indexOfLast { it.mode == failedItem.mode } + 1
            rebuilt.add(sectionEnd, failedItem)
        }
        items.clear()
        items.addAll(rebuilt)
        drift = true
    }

    // -- operations (all run on the executor) ----------------------------------

    private fun doEnqueue(params: JsonObject): JsonObject {
        val mode = params.string("mode")?.takeIf { it == "steer" || it == "followUp" }
            ?: return errorJson("queue.enqueue requires mode steer|followUp")
        val text = params.string("text") ?: ""
        val images = params.images()
        if (text.isBlank() && images.isEmpty()) return errorJson("queue.enqueue requires text or images")

        val item = newItem(mode, text, images)
        items.add(item)
        normalize()
        push(snapshotJson()) // optimistic: the entry is visible before the RPC answers
        return try {
            rpc(enqueueCommand(mode, text, images))
            buildJsonObject { put("ok", true); put("id", item.id) }
        } catch (e: Exception) {
            // US5-4: never lose the entry silently — mark it failed in place.
            replace(item.id) { it.copy(status = "failed", error = e.message ?: "enqueue failed") }
            push(snapshotJson())
            buildJsonObject {
                put("ok", false)
                put("retained", true)
                put("id", item.id)
                put("error", e.message ?: "enqueue failed")
            }
        }
    }

    private fun doMove(params: JsonObject): JsonObject {
        val id = params.string("id") ?: return errorJson("queue.move requires id")
        // The web sends a JSON number; accept a string too so a hand-typed
        // request cannot silently no-op.
        val delta = (params["delta"] as? JsonPrimitive)?.content?.toIntOrNull()
            ?: return errorJson("queue.move requires delta")
        val idx = items.indexOfFirst { it.id == id }
        if (idx < 0) return errorJson("no queue item $id")
        val target = idx + delta
        // Edge — or a swap that would cross the steer/followUp sections, which
        // cannot change pi's arrays and would be a displayed lie. pi untouched.
        if (target < 0 || target >= items.size || items[target].mode != items[idx].mode) {
            return buildJsonObject { put("ok", false); put("error", "at edge") }
        }
        if (paused) {
            // Parked: pi's queue is empty and the mirror is the only truth.
            // clear→reconcile here would compare against empty arrays and wipe
            // the parked entries (found by the real-machine pass) — operate
            // locally; resume re-enqueues in the new order.
            items[idx] = items[target].also { items[target] = items[idx] }
            push(snapshotJson())
            return okJson()
        }
        val rc = clearAndReconcile()
        if (!rc.matched || items.none { it.id == id }) {
            reEnqueue(rc.cleared)
            return opAborted()
        }
        val from = items.indexOfFirst { it.id == id }
        val to = from + delta
        if (to < 0 || to >= items.size || items[to].mode != items[from].mode) {
            // The clear raced a consumption; the mirror no longer allows the swap.
            reEnqueue(rc.cleared)
            return buildJsonObject { put("ok", false); put("error", "queue changed") }
        }
        items[from] = items[to].also { items[to] = items[from] }
        reEnqueueQueued()
        push(snapshotJson())
        return okJson()
    }

    private fun doRemove(params: JsonObject): JsonObject {
        val id = params.string("id") ?: return errorJson("queue.remove requires id")
        if (items.none { it.id == id }) return errorJson("no queue item $id")
        if (paused) {
            // Parked: the mirror is the only truth (see doMove).
            items.removeIf { it.id == id }
            push(snapshotJson())
            return okJson()
        }
        val rc = clearAndReconcile()
        val target = items.firstOrNull { it.id == id }
        if (!rc.matched || target == null || target.status == "failed") {
            // Gone in a drift rebuild, or never in pi's queue to begin with.
            reEnqueue(rc.cleared)
            return buildJsonObject { put("ok", false); put("error", "no queue item $id") }
        }
        items.removeIf { it.id == id }
        reEnqueueQueued()
        push(snapshotJson())
        return okJson()
    }

    /** Takes one item out of the queue and returns it for composer backfill. */
    private fun doRestore(params: JsonObject): JsonObject {
        val id = params.string("id") ?: return errorJson("queue.restore requires id")
        if (items.none { it.id == id }) return errorJson("no queue item $id")
        val target = items.firstOrNull { it.id == id }
        if (paused) {
            // Parked: the mirror is the only truth (see doMove).
            if (target == null) return errorJson("no queue item $id")
            items.removeIf { it.id == id }
            push(snapshotJson())
            return restoredJson(target)
        }
        val rc = clearAndReconcile()
        val reconciled = items.firstOrNull { it.id == id }
        if (!rc.matched || reconciled == null) {
            reEnqueue(rc.cleared)
            return buildJsonObject { put("ok", false); put("error", "no queue item $id") }
        }
        items.removeIf { it.id == id }
        reEnqueueQueued()
        push(snapshotJson())
        return restoredJson(reconciled)
    }

    private fun restoredJson(item: Item): JsonObject = buildJsonObject {
        put("ok", true)
        put("id", item.id)
        put("text", item.text)
        put("images", JsonArray(item.images.map {
            buildJsonObject { put("data", it.data); put("mimeType", it.mimeType) }
        }))
    }

    /** Turns a follow-up into a steer; pi injects it during the current run. */
    private fun doPromote(params: JsonObject): JsonObject {
        val id = params.string("id") ?: return errorJson("queue.promote requires id")
        val target = items.firstOrNull { it.id == id } ?: return errorJson("no queue item $id")
        if (target.mode == "steer") return okJson() // already a steer
        if (paused) {
            // Parked: relabel locally; resume fires steers first (see doResume).
            replace(id) { it.copy(mode = "steer") }
            normalize()
            push(snapshotJson())
            return okJson()
        }
        if (piIsIdle()) {
            // US6-2: an idle promote degrades to a direct send — no queueing,
            // no touching the rest of the queue.
            items.removeIf { it.id == id }
            runCatching { rpc(promptCommand(target.text, target.images)) }
            push(snapshotJson())
            return okJson()
        }
        val rc = clearAndReconcile()
        val current = items.firstOrNull { it.id == id }
        if (!rc.matched || current == null || current.mode != "followUp") {
            reEnqueue(rc.cleared)
            return buildJsonObject { put("ok", false); put("error", "no follow-up item $id") }
        }
        replace(id) { it.copy(mode = "steer") }
        normalize()
        reEnqueueQueued()
        push(snapshotJson())
        return okJson()
    }

    /** Manual pause: park the mirror, empty pi's queue best-effort. */
    private fun doPause(params: JsonObject): JsonObject {
        if (items.isEmpty()) return buildJsonObject { put("ok", true); put("paused", false) }
        runCatching { rpc(clearQueueCommand()) }
        paused = true
        pauseReason = params.string("reason") ?: "manual"
        push(snapshotJson())
        return okJson()
    }

    /** Resume = re-enqueue in mirror order. Missed time is not made up. */
    private fun doResume(): JsonObject {
        if (!paused) return okJson()
        paused = false
        pauseReason = null
        val queued = items.filter { it.status == "queued" }
        if (queued.isNotEmpty() && piIsIdle()) {
            // Real-pi probe (2026-11-04): a follow_up on an idle process never
            // self-starts — it would sit there forever. Fire the first entry
            // as a plain prompt so 继续 delivers immediately (FR-013); the
            // rest chain after it settles. Steering on an idle process is
            // meaningless anyway (US5-3), so every mode demotes to a prompt.
            val first = queued.first()
            runCatching { rpc(promptCommand(first.text, first.images)) }
            for (item in queued.drop(1)) {
                runCatching { rpc(enqueueCommand(item.mode, item.text, item.images)) }
            }
        } else {
            reEnqueueQueued()
        }
        push(snapshotJson())
        return okJson()
    }

    /** True when no pi run is active (tracked from agent_start/agent_settled). */
    private fun piIsIdle(): Boolean = !piStreaming

    private fun promptCommand(text: String, images: List<Image>): JsonObject = buildJsonObject {
        put("type", "prompt")
        put("message", text)
        if (images.isNotEmpty()) {
            put("images", JsonArray(images.map {
                buildJsonObject { put("type", "image"); put("data", it.data); put("mimeType", it.mimeType) }
            }))
        }
    }

    private fun doClear(): JsonObject {
        if (items.isNotEmpty() || paused) {
            // pi may already be gone (process exit); clearing is best-effort.
            runCatching { rpc(clearQueueCommand()) }
        }
        items.clear()
        paused = false
        pauseReason = null
        drift = false
        push(snapshotJson())
        return okJson()
    }

    // -- primitives ------------------------------------------------------------

    /** Result of [clearAndReconcile]: what pi held, and whether the mirror matched. */
    private class Reconciled(val cleared: Pair<List<String>, List<String>>, val matched: Boolean)

    /**
     * The one way to change pi's queue: take everything out, then put it back.
     * Always returns what pi held — on a mismatch the mirror is rebuilt from
     * those arrays and `matched` is false, so the caller can put pi's own
     * order back instead of proceeding with a stale plan.
     */
    private fun clearAndReconcile(): Reconciled {
        val resp = rpc(clearQueueCommand())
        val steering = resp.stringList("steering")
        val followUp = resp.stringList("followUp")
        val queued = items.filter { it.status == "queued" }
        val matched = matchesQueue(queued, steering, followUp)
        if (!matched) {
            // Someone changed the queue outside this window (or a consumption
            // raced the clear). pi wins; the caller's operation is abandoned.
            rebuildFrom(steering, followUp)
        }
        return Reconciled(steering to followUp, matched)
    }

    /** Puts pi's own order back after an aborted operation. */
    private fun reEnqueue(cleared: Pair<List<String>, List<String>>) {
        for ((text, mode) in cleared.first.map { it to "steer" } + cleared.second.map { it to "followUp" }) {
            runCatching { rpc(enqueueCommand(mode, text, emptyList())) }
        }
        push(snapshotJson())
    }

    /** Re-sends the queued mirror items; failed ones stay local-only. */
    private fun reEnqueueQueued() {
        for (item in items.filter { it.status == "queued" }) {
            runCatching { rpc(enqueueCommand(item.mode, item.text, item.images)) }
        }
    }

    private fun clearQueueCommand(): JsonObject = buildJsonObject { put("type", "clear_queue") }

    private fun enqueueCommand(mode: String, text: String, images: List<Image>): JsonObject =
        buildJsonObject {
            put("type", if (mode == "steer") "steer" else "follow_up")
            put("message", text)
            if (images.isNotEmpty()) {
                put("images", JsonArray(images.map {
                    buildJsonObject { put("type", "image"); put("data", it.data); put("mimeType", it.mimeType) }
                }))
            }
        }

    private fun newItem(mode: String, text: String, images: List<Image>): Item =
        Item(
            id = "q-${idSeq.incrementAndGet()}",
            mode = mode,
            text = text,
            images = images,
            status = "queued",
            createdAt = System.currentTimeMillis(),
        )

    /** Steering first (it fires during the current run), then follow-ups. */
    private fun normalize() {
        items.sortBy { if (it.mode == "steer") 0 else 1 }
    }

    private fun replace(id: String, transform: (Item) -> Item) {
        val idx = items.indexOfFirst { it.id == id }
        if (idx >= 0) items[idx] = transform(items[idx])
    }

    private fun snapshotJson(): JsonObject = buildJsonObject {
        put("type", "queue_state")
        put("items", JsonArray(items.map { it.toJson() }))
        put("paused", paused)
        put("pauseReason", pauseReason)
        put("drift", drift)
    }

    private fun Item.toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("mode", mode)
        put("text", text)
        put("images", JsonArray(images.map {
            buildJsonObject { put("data", it.data); put("mimeType", it.mimeType) }
        }))
        put("status", status)
        error?.let { put("error", it) }
        put("createdAt", createdAt)
    }

    private fun okJson(): JsonObject = buildJsonObject { put("ok", true) }

    private fun opAborted(): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", "queue was changed elsewhere; rebuilt from pi")
    }

    private fun errorJson(message: String): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", message)
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.stringList(key: String): List<String> =
        (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()

    private fun JsonObject.images(): List<Image> =
        (this["images"] as? JsonArray)?.mapNotNull { el ->
            (el as? JsonObject)?.let { o ->
                val data = (o["data"] as? JsonPrimitive)?.content ?: return@let null
                val mime = (o["mimeType"] as? JsonPrimitive)?.content ?: "image/png"
                Image(data, mime)
            }
        } ?: emptyList()
}
