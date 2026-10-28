package dev.pi.agent.rpc

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** A completed command response record from pi. */
data class RpcResponse(
    val command: String?,
    val success: Boolean,
    val data: JsonElement?,
    val error: String?,
    val raw: JsonObject,
)

/** Callbacks for the RPC client lifecycle. */
interface PiRpcListener {
    /** A session event record (anything that is not a command response). */
    fun onEvent(event: JsonObject)

    /** The protocol stream ended (EOF or read error). [message] explains why. */
    fun onClosed(message: String)
}

/**
 * Speaks pi's RPC protocol over a child process' stdin/stdout.
 *
 * All methods are thread-safe. [send] completes with the correlated response;
 * session events are delivered on the reader thread via [listener].
 */
class PiRpcClient(
    private val process: Process,
    private val listener: PiRpcListener,
) : AutoCloseable {

    private val json = Json { ignoreUnknownKeys = true }
    private val pending = ConcurrentHashMap<String, CompletableFuture<RpcResponse>>()
    private val writeLock = Any()
    private val counter = AtomicLong()

    @Volatile
    private var closed = false

    private val stdin: OutputStream = process.outputStream
    private val readerThread = Thread({ readerLoop() }, "pi-rpc-reader").apply {
        isDaemon = true
        start()
    }

    fun nextId(): String = "req-${counter.incrementAndGet()}"

    /**
     * Sends a command and completes with its response.
     * The future completes exceptionally if the process dies first.
     */
    fun send(command: JsonObject, id: String = nextId()): CompletableFuture<RpcResponse> {
        val future = CompletableFuture<RpcResponse>()
        pending[id] = future
        val record = JsonObject(command + mapOf("id" to JsonPrimitive(id)))
        val ok = write(record)
        if (!ok) {
            pending.remove(id)
            future.completeExceptionally(IOException("pi process is not running"))
        }
        return future
    }

    /** Fire-and-forget send used for commands whose response is ignored. */
    fun notify(command: JsonObject): Boolean = write(command)

    private fun write(record: JsonObject): Boolean {
        if (closed) return false
        return try {
            val line = record.toString()
            synchronized(writeLock) {
                stdin.write(line.toByteArray(Charsets.UTF_8))
                stdin.write('\n'.code)
                stdin.flush()
            }
            true
        } catch (e: IOException) {
            false
        }
    }

    private fun readerLoop() {
        val reader = LfLineReader(process.inputStream)
        var endMessage: String? = null
        try {
            while (true) {
                val line = reader.readLine() ?: run {
                    endMessage = "pi process closed stdout (exit code ${process.exitValue()})"
                    break
                }
                if (line.isBlank()) continue
                val element = try {
                    json.parseToJsonElement(line)
                } catch (e: Exception) {
                    continue // not JSON: pi reserves stderr for diagnostics; ignore stdout noise
                }
                val obj = element as? JsonObject ?: continue
                if (obj["type"]?.jsonPrimitive?.contentOrNull == "response") {
                    val id = obj["id"]?.jsonPrimitive?.contentOrNull
                    val future = id?.let { pending.remove(it) }
                    future?.complete(toResponse(obj))
                } else {
                    try {
                        listener.onEvent(obj)
                    } catch (e: Exception) {
                        // listener must not kill the reader loop
                    }
                }
            }
        } catch (e: Exception) {
            endMessage = "error reading pi output: ${e.message}"
        } finally {
            closed = true
            try {
                reader.close()
            } catch (_: IOException) {
            }
            val message = endMessage ?: "pi rpc stream ended"
            pending.values.forEach { it.completeExceptionally(IOException(message)) }
            pending.clear()
            listener.onClosed(message)
        }
    }

    private fun toResponse(obj: JsonObject): RpcResponse = RpcResponse(
        command = obj["command"]?.jsonPrimitive?.contentOrNull,
        success = obj["success"]?.jsonPrimitive?.booleanOrNull ?: false,
        data = obj["data"],
        error = obj["error"]?.jsonPrimitive?.contentOrNull,
        raw = obj,
    )

    override fun close() {
        closed = true
        // Closing stdin asks pi for an orderly shutdown.
        try {
            synchronized(writeLock) { stdin.close() }
        } catch (_: IOException) {
        }
        readerThread.join(3000)
    }
}
