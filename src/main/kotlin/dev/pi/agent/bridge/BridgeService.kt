package dev.pi.agent.bridge

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import com.intellij.util.ui.UIUtil
import dev.pi.agent.process.PiConnectionState
import dev.pi.agent.process.PiProcessManager
import dev.pi.agent.rpc.PiRpcClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.future.await
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.cef.browser.CefBrowser

/**
 * Routes JSON-envelope messages between the web frontend and plugin services.
 *
 * Wire format (JS → Java): `{"t": "<method>", "id": "<reqId>", "p": {…}}`
 * Responses and pushed events go through [push] as
 * `{"t":"resp","id":…,…}` / `{"t":"event","name":…,"data":…}`.
 */
@Service(Service.Level.PROJECT)
class BridgeService(private val project: Project) : Disposable {

    private val LOG = Logger.getInstance(BridgeService::class.java)
    private val json = Json { encodeDefaults = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    private var sink: CefBrowser? = null

    private var piEventsWired = false

    /** Called on the JCEF IO thread with the raw message body. */
    fun handleMessage(message: String) {
        scope.launch {
            val element = try {
                json.parseToJsonElement(message).jsonObject
            } catch (e: Exception) {
                LOG.warn("bridge: malformed message: ${message.take(200)}")
                return@launch
            }
            runCatching { dispatch(element) }
                .onFailure { LOG.warn("bridge: handler failed for ${element["t"]}", it) }
        }
    }

    private suspend fun dispatch(msg: JsonObject) {
        val id = msg["id"]?.let { it as? JsonPrimitive }?.content ?: ""
        val method = msg["t"]?.let { it as? JsonPrimitive }?.content ?: return
        val params = msg["p"] as? JsonObject ?: JsonObject(emptyMap())
        try {
            val data: JsonObject = when (method) {
                "ping" -> buildJsonObject { put("pong", true) }
                "env" -> envInfo()
                "rpc.request" -> rpcRequest(params)
                else -> throw IllegalArgumentException("unknown bridge method: $method")
            }
            push(buildJsonObject {
                put("t", "resp")
                put("id", id)
                put("ok", true)
                put("data", data)
            })
        } catch (e: Exception) {
            push(buildJsonObject {
                put("t", "resp")
                put("id", id)
                put("ok", false)
                put("error", e.message ?: e.toString())
            })
        }
    }

    private fun envInfo(): JsonObject = buildJsonObject {
        put("projectName", project.name)
        put("projectPath", project.basePath ?: "")
        put("theme", if (JBColor.isBright()) "light" else "dark")
        put("editorFontFamily", UIUtil.getLabelFont().family)
    }

    private suspend fun rpcRequest(params: JsonObject): JsonObject {
        val command = params["command"] as? JsonObject
            ?: throw IllegalArgumentException("rpc.request requires command object")
        val client: PiRpcClient = PiProcessManager.getInstance(project).client()
            ?: throw IllegalStateException("pi process is not running")
        val response = client.send(command).await()
        return response.raw
    }

    // -- push channel -------------------------------------------------------

    fun registerSink(browser: CefBrowser) {
        sink = browser
        wirePiEvents()
        // Initial state so a freshly loaded page syncs immediately.
        val state = PiProcessManager.getInstance(project).state
        pushStateEvent(state)
    }

    private fun wirePiEvents() {
        if (piEventsWired) return
        piEventsWired = true
        val manager = PiProcessManager.getInstance(project)
        manager.addEventListener { event ->
            push(buildJsonObject {
                put("t", "event")
                put("name", "pi")
                put("data", event)
            })
        }
        manager.addStateListener { state -> pushStateEvent(state) }
    }

    private fun pushStateEvent(state: PiConnectionState) {
        val data = when (state) {
            is PiConnectionState.NotStarted -> buildJsonObject { put("status", "notStarted") }
            is PiConnectionState.Starting -> buildJsonObject {
                put("status", "starting"); put("version", state.installation.version ?: "")
            }
            is PiConnectionState.Running -> buildJsonObject {
                put("status", "running"); put("version", state.installation.version ?: "")
            }
            is PiConnectionState.Exited -> buildJsonObject {
                put("status", "exited")
                put("message", state.message)
                put("stderr", state.stderrTail ?: "")
            }
        }
        push(buildJsonObject {
            put("t", "event")
            put("name", "pi-state")
            put("data", data)
        })
    }

    private fun push(record: JsonObject) {
        val browser = sink ?: return
        try {
            browser.executeJavaScript("window.__piEvent && window.__piEvent(${record});", browser.url, 0)
        } catch (e: Exception) {
            LOG.warn("bridge: failed to push to frontend", e)
        }
    }

    override fun dispose() {
        scope.cancel()
        sink = null
    }

    companion object {
        @JvmStatic
        fun getInstance(project: Project): BridgeService = project.getService(BridgeService::class.java)
    }
}
