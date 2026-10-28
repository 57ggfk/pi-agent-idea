package dev.pi.agent.ui

import com.intellij.openapi.diagnostic.Logger
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.Executors

/**
 * Serves the packaged web UI from the plugin classloader over loopback HTTP.
 *
 * JCEF loads `baseUrl`; the frontend is otherwise environment-agnostic, which
 * lets the same bundle be served by Vite (dev) or Playwright (e2e).
 *
 * Bound to the loopback interface on an ephemeral port only.
 */
class LocalUiServer private constructor() {

    private val LOG = Logger.getInstance(LocalUiServer::class.java)

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
        if (exchange.requestMethod != "GET" && exchange.requestMethod != "HEAD") {
            exchange.sendResponseHeaders(405, -1)
            exchange.close()
            return
        }

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
