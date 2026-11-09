package dev.pi.agent.ui

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import dev.pi.agent.bridge.BridgeService
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.add
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
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
 * Every open project gets its own bridge token ([uiUrlFor]); requests are
 * routed to that project's [BridgeService] by the token, so multiple IDE
 * windows are fully isolated. Tokens are handed to the SPA through the load
 * URL's query string; without a valid token, any local process or malicious
 * web page (cross-origin POST to loopback) could drive the agent.
 *
 * The frontend is otherwise environment-agnostic, which lets the same bundle
 * be served by Vite (dev) or Playwright (e2e).
 *
 * Bound to the loopback interface on an ephemeral port only.
 */
class LocalUiServer private constructor() {

    private val LOG = Logger.getInstance(LocalUiServer::class.java)

    // Bind the IPv4 loopback explicitly. InetAddress.getLoopbackAddress()
    // follows java.net.preferIPv6Addresses: on such a JVM the server listens
    // on [::1] while every URL below still says 127.0.0.1, Chromium gets
    // connection refused, and the tool window stays white with no hint.
    private val bindAddress: InetAddress = InetAddress.getByName("127.0.0.1")
    private val server: HttpServer = HttpServer.create(InetSocketAddress(bindAddress, 0), 0)
    val port: Int = server.address.port
    val baseUrl: String = "http://${server.address.address.hostAddress}:$port/"

    private val bridgeAuth = BridgeAuth(ownOrigin = baseUrl.dropLast(1))
    private val projectTokens = ConcurrentHashMap<String, Project>()

    /**
     * First-contact breadcrumbs. A panel stuck on "Connecting to pi…" is
     * otherwise indistinguishable between "the page never called us" (CEF
     * network stack wedged — the real-machine 144-vs-122 mismatch) and "we
     * answered but the renderer never got it", so name both transitions once
     * per server lifetime.
     */
    private val healthProbeSeen = java.util.concurrent.atomic.AtomicBoolean(false)
    private val pollConnectedSeen = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Load URL for a project's tool window panel; carries its bridge token. */
    fun uiUrlFor(project: Project): String {
        pruneDisposed()
        val existing = projectTokens.entries.firstOrNull { it.value === project }?.key
        val token = existing ?: generateToken().also { projectTokens[it] = project }
        return "$baseUrl?token=$token"
    }

    private fun pruneDisposed() {
        projectTokens.entries.removeIf { it.value.isDisposed }
    }

    /** Resolves the authenticated project for a bridge request, or null. */
    private fun projectFor(exchange: HttpExchange): Project? {
        if (!bridgeAuth.originAllowed(exchange.requestHeaders.getFirst("Origin"))) return null
        val token = exchange.requestHeaders.getFirst("X-Pi-Token") ?: return null
        val project = projectTokens[token] ?: return null
        if (project.isDisposed) {
            projectTokens.remove(token)
            return null
        }
        return project
    }

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
            // Path only: the query string carries the project's bridge token,
            // and idea.log gets pasted into bug reports.
            LOG.warn("UI request failed: ${exchange.requestURI.path}", e)
            try {
                exchange.sendResponseHeaders(500, -1)
                exchange.close()
            } catch (_: Exception) {
            }
        }
    }

    private fun unauthorized(exchange: HttpExchange) {
        respondJson(exchange, 403, buildJsonObject { put("ok", false); put("error", "unauthorized") })
    }

    private fun handle(exchange: HttpExchange) {
        val uriPath = exchange.requestURI.path ?: "/"
        val method = exchange.requestMethod

        when {
            uriPath == "/bridge/health" && method == "GET" -> {
                if (healthProbeSeen.compareAndSet(false, true)) {
                    LOG.info("bridge health probe answered — the embedded page reached the UI server")
                }
                respondJson(exchange, 200, buildJsonObject { put("ok", true) })
            }

            uriPath == "/bridge" && method == "POST" -> {
                val project = projectFor(exchange)
                if (project == null) {
                    unauthorized(exchange)
                    return
                }
                val body = readBody(exchange)
                    ?: run {
                        respondJson(exchange, 413, buildJsonObject { put("ok", false); put("error", "payload too large") })
                        return
                    }
                BridgeService.getInstance(project).handleEnvelope(body)
                respondJson(exchange, 202, buildJsonObject { put("queued", true) })
            }

            uriPath == "/bridge/poll" && method == "GET" -> {
                val project = projectFor(exchange)
                if (project == null) {
                    unauthorized(exchange)
                    return
                }
                val service = BridgeService.getInstance(project)
                service.ensureWired()
                if (pollConnectedSeen.compareAndSet(false, true)) {
                    LOG.info("bridge poll connected — the frontend is authenticated and polling")
                }
                val params = exchange.requestURI.rawQuery ?: ""
                val cursor = params.split("&")
                    .map { it.split("=", limit = 2) }
                    .firstOrNull { it[0] == "cursor" }
                    ?.get(1)?.toLongOrNull() ?: 0L
                val timeoutMs = params.split("&")
                    .map { it.split("=", limit = 2) }
                    .firstOrNull { it[0] == "timeout" }
                    ?.get(1)?.toLongOrNull()?.coerceIn(0, 25_000) ?: 20_000L
                val entries = service.pollEvents(cursor, timeoutMs)
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
                    put("oldest", service.oldestSeq())
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

    private fun serveResource(exchange: HttpExchange, uriPath: String) {
        // Serve /webui/* from the classloader; fall back to index.html (SPA).
        val resourcePath = "webui" + (if (uriPath == "/") "/index.html" else uriPath)
        val resource: InputStream? = javaClass.classLoader.getResourceAsStream(resourcePath)
        if (resource == null) {
            // A missing bundle asset is exactly what a blank panel looks like
            // from the outside, so name the path in the log.
            LOG.warn("UI resource not found: $resourcePath (from ${exchange.requestURI.path})")
            exchange.sendResponseHeaders(404, -1)
            exchange.close()
            return
        }

        val bytes = resource.use { it.readBytes() }
        // The document load is the only trace the plugin can leave that the
        // embedded page (re)started: the platform runs CEF with logging
        // disabled, and a dead renderer produces no other evidence. Without
        // this line, "the panel froze" and "the panel was idle" look identical
        // in idea.log. Path only — the query string is the bridge token.
        if (resourcePath.endsWith("/index.html")) {
            LOG.info("UI page served (${bytes.size} bytes, from ${exchange.requestURI.path})")
        }
        exchange.responseHeaders.set("Content-Type", contentType(resourcePath))
        exchange.responseHeaders.set("Cache-Control", "no-store")
        exchange.sendResponseHeaders(200, bytes.size.toLong())
        if (exchange.requestMethod != "HEAD") {
            exchange.responseBody.use { it.write(bytes) }
        } else {
            exchange.responseBody.close()
        }
    }

    /** Reads the POST body, or null when it exceeds [MAX_BODY_BYTES]. */
    private fun readBody(exchange: HttpExchange): String? {
        val bytes = exchange.requestBody.readNBytes(MAX_BODY_BYTES + 1)
        if (bytes.size > MAX_BODY_BYTES) return null
        return bytes.toString(Charsets.UTF_8)
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
        /** POST body ceiling; image envelopes are base64 and can legitimately be large. */
        private const val MAX_BODY_BYTES = 16 * 1024 * 1024

        @Volatile
        private var instance: LocalUiServer? = null

        @JvmStatic
        fun getInstance(): LocalUiServer = instance ?: synchronized(this) {
            instance ?: LocalUiServer().also { instance = it }
        }

        internal fun generateToken(): String {
            val bytes = ByteArray(32)
            SecureRandom().nextBytes(bytes)
            return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        }
    }
}
