package dev.pi.agent.ui

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.ProjectManager
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import dev.pi.agent.bridge.BridgeService
import dev.pi.agent.bridge.BridgeTransport
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.Executors

/**
 * Serves the packaged web UI from the plugin classloader over loopback HTTP
 * and carries the bridge transport:
 *
 *  - `GET  /webui/…`            packaged frontend
 *  - `GET  /bridge/health`      frontend ⇄ IDE detection probe
 *  - `POST /bridge`             enqueue a `{t,id,p}` envelope (202, async reply)
 *  - `GET  /bridge/poll?cursor` long-poll for responses and pushed events
 *
 * JCEF loads `baseUrl`; the frontend is otherwise environment-agnostic, which
 * lets the same bundle be served by Vite (dev) or Playwright (e2e).
 *
 * Bound to the loopback interface on an ephemeral port only.
 */
class LocalUiServer private constructor() {

    private val LOG = Logger.getInstance(LocalUiServer::class.java)
    private val json = Json { encodeDefaults = true }

    private val server: HttpServer = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
    val port: Int = server.address.port
    val baseUrl: String = "http://127.0.0.1:$port/"

    init {
        server.createContext("/") { exchange -> safeHandle(exchange) }
        server.executor = Executors.newCachedThreadPool { r ->
            Thread(r, "pi-agent-ui-http").apply { isDaemon = true }
        }
        server.start()
        LOG.info("pi agent UI server started on $baseUrl")
    }

    private fun safeHandle(exchange: HttpExchange) {
        try {
            handle(exchange)
        } catch (e: Exception) {
            LOG.warn("UI request failed: ${exchange.requestURI}", e)
            try {
                exchange.sendResponseHeaders(500, -1)
                exchange.close()
            } catch (_: Exception) {
            }
        }
    }

    private fun handle(exchange: HttpExchange) {
        val uriPath = exchange.requestURI.path ?: "/"
        val method = exchange.requestMethod

        when {
            uriPath == "/bridge/health" && method == "GET" -> {
                respondJson(exchange, 200, buildJsonObject { put("ok", true) })
            }

            uriPath == "/bridge" && method == "POST" -> {
                val body = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
                bridgeService()?.handleEnvelope(body)
                respondJson(exchange, 202, buildJsonObject { put("queued", true) })
            }

            uriPath == "/bridge/poll" && method == "GET" -> {
                bridgeService()?.ensureWired()
                val params = exchange.requestURI.rawQuery ?: ""
                val cursor = params.split("&")
                    .map { it.split("=", limit = 2) }
                    .firstOrNull { it[0] == "cursor" }
                    ?.get(1)?.toLongOrNull() ?: 0L
                val timeoutMs = params.split("&")
                    .map { it.split("=", limit = 2) }
                    .firstOrNull { it[0] == "timeout" }
                    ?.get(1)?.toLongOrNull()?.coerceIn(0, 25_000) ?: 20_000L
                val entries = BridgeTransport.pollAfter(cursor, timeoutMs)
                val lastSeq = entries.lastOrNull()?.seq ?: cursor
                val payload = buildJsonObject {
                    put("events", buildJsonArray {
                        entries.forEach { entry ->
                            add(buildJsonObject {
                                put("seq", entry.seq)
                                put("record", entry.record)
                            })
                        }
                    })
                    put("cursor", lastSeq)
                }
                respondJson(exchange, 200, payload)
            }

            method == "GET" || method == "HEAD" -> serveResource(exchange, uriPath)

            else -> {
                exchange.sendResponseHeaders(405, -1)
                exchange.close()
            }
        }
    }

    /** MVP routing: a single open project. Multi-window support tracked in docs. */
    private fun bridgeService(): BridgeService? =
        ProjectManager.getInstanceIfCreated()?.openProjects?.firstOrNull()?.let {
            BridgeService.getInstance(it)
        }

    private fun serveResource(exchange: HttpExchange, uriPath: String) {
        // Serve /webui/* from the classloader; fall back to index.html (SPA).
        val resourcePath = "webui" + (if (uriPath == "/") "/index.html" else uriPath)
        val resource: InputStream? = javaClass.classLoader.getResourceAsStream(resourcePath)
        if (resource == null) {
            exchange.sendResponseHeaders(404, -1)
            exchange.close()
            return
        }

        val bytes = resource.use { it.readBytes() }
        exchange.responseHeaders.set("Content-Type", contentType(resourcePath))
        exchange.responseHeaders.set("Cache-Control", "no-store")
        exchange.sendResponseHeaders(200, bytes.size.toLong())
        if (exchange.requestMethod != "HEAD") {
            exchange.responseBody.use { it.write(bytes) }
        } else {
            exchange.responseBody.close()
        }
    }

    private fun respondJson(exchange: HttpExchange, status: Int, payload: kotlinx.serialization.json.JsonObject) {
        val bytes = payload.toString().toByteArray(Charsets.UTF_8)
        exchange.responseHeaders.set("Content-Type", "application/json; charset=utf-8")
        exchange.responseHeaders.set("Cache-Control", "no-store")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun contentType(path: String): String = when {
        path.endsWith(".html") -> "text/html; charset=utf-8"
        path.endsWith(".js") || path.endsWith(".mjs") -> "text/javascript; charset=utf-8"
        path.endsWith(".css") -> "text/css; charset=utf-8"
        path.endsWith(".json") -> "application/json; charset=utf-8"
        path.endsWith(".svg") -> "image/svg+xml"
        path.endsWith(".png") -> "image/png"
        path.endsWith(".ico") -> "image/x-icon"
        path.endsWith(".woff2") -> "font/woff2"
        else -> "application/octet-stream"
    }

    fun stop() {
        server.stop(0)
    }

    companion object {
        @Volatile
        private var instance: LocalUiServer? = null

        @JvmStatic
        fun getInstance(): LocalUiServer = instance ?: synchronized(this) {
            instance ?: LocalUiServer().also { instance = it }
        }
    }
}
