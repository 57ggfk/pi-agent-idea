package dev.pi.agent.manage

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import dev.pi.agent.process.OsProcess
import dev.pi.agent.process.PiLocator
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.BufferedWriter
import java.io.File
import java.io.OutputStreamWriter
import java.util.concurrent.atomic.AtomicReference

/**
 * Drives pi's real browser OAuth (spec 014) through a small helper script
 * running on the user's own pi installation.
 *
 * The chain is: UI ↔ bridge ↔ [PiLoginSupport] ↔ JSON-lines ↔ pi-login.mjs ↔
 * (SDK import) ↔ the user's pi. The pi SDK is never bundled — the .mjs (a
 * plugin resource, extracted like the pi-approve extension) resolves the
 * package root from the pi binary path and imports ModelRuntime from there,
 * so login code and CLI always come from the same install.
 *
 * Exactly one login runs at a time (US4); the credential itself is written by
 * pi into auth.json under proper-lockfile, never through this class.
 */
object PiLoginSupport {
    private val LOG = Logger.getInstance(PiLoginSupport::class.java)

    // No leading slash: PluginClassLoader resolves root-relative paths.
    private const val SCRIPT_RESOURCE = "pi-login/pi-login.mjs"
    private const val SCRIPT_FILE_NAME = "pi-login.mjs"

    /** Classifier result for one protocol line from the helper. */
    internal sealed class Line {
        data object Ready : Line()
        data class Event(val ev: JsonObject) : Line()
        data class Prompt(val id: Int, val p: JsonObject) : Line()
        data class Log(val line: String) : Line()
        data class Done(
            val ok: Boolean,
            val cancelled: Boolean = false,
            val provider: String? = null,
            val type: String? = null,
            val error: String? = null,
        ) : Line()
        data class Unknown(val raw: String) : Line()
    }

    /**
     * Pure protocol classifier (spec 014 T2): every line the helper prints is
     * one JSON object tagged with "t"; anything unparsable or foreign is
     * [Line.Unknown] and only ever becomes a log entry — the helper redirects
     * its own console noise to stderr, but node itself can still print here.
     */
    internal fun classify(line: String): Line {
        val trimmed = line.trim()
        if (!trimmed.startsWith("{")) return Line.Unknown(trimmed.take(200))
        val obj = try {
            Json.parseToJsonElement(trimmed).jsonObject
        } catch (_: Exception) {
            return Line.Unknown(trimmed.take(200))
        }
        return when (obj["t"]?.let { it as? JsonPrimitive }?.content) {
            "ready" -> Line.Ready
            "event" -> (obj["ev"] as? JsonObject)?.let { Line.Event(it) } ?: Line.Unknown(trimmed.take(200))
            "prompt" -> {
                val id = obj["id"]?.let { it as? JsonPrimitive }?.content?.toIntOrNull()
                    ?: return Line.Unknown(trimmed.take(200))
                val p = obj["p"] as? JsonObject ?: return Line.Unknown(trimmed.take(200))
                Line.Prompt(id, p)
            }
            "log" -> Line.Log(obj["line"]?.let { it as? JsonPrimitive }?.content ?: "")
            "done" -> Line.Done(
                ok = obj["ok"]?.let { it as? JsonPrimitive }?.booleanOrNull ?: false,
                cancelled = obj["cancelled"]?.let { it as? JsonPrimitive }?.booleanOrNull ?: false,
                provider = obj["provider"]?.let { it as? JsonPrimitive }?.content,
                type = obj["type"]?.let { it as? JsonPrimitive }?.content,
                error = obj["error"]?.let { it as? JsonPrimitive }?.content,
            )
            else -> Line.Unknown(trimmed.take(200))
        }
    }

    /** The extracted helper script, overwritten on every start so upgrades propagate. */
    fun scriptFile(): File = File(PathManager.getConfigDir().toFile(), "pi-agent/pi-login.mjs")

    internal fun extractScript(): File? {
        val out = scriptFile()
        return try {
            out.parentFile?.mkdirs()
            val resource = PiLoginSupport::class.java.classLoader.getResourceAsStream(SCRIPT_RESOURCE)
            if (resource == null) {
                LOG.warn("pi-login helper resource missing: $SCRIPT_RESOURCE")
                return null
            }
            resource.use { input -> out.outputStream().use { input.copyTo(it) } }
            out
        } catch (e: Exception) {
            LOG.warn("failed to install pi-login helper", e)
            null
        }
    }

    private class Session(
        val project: Project,
        val provider: String,
        val process: Process,
        val writer: BufferedWriter,
    ) {
        @Volatile var cancelRequested = false
        @Volatile var sawDone = false
    }

    private val session = AtomicReference<Session?>(null)

    /** True while a login is in flight (US4: the UI disables re-entry). */
    fun isActive(): Boolean = session.get() != null

    fun start(project: Project, params: JsonObject): JsonObject {
        val provider = params["provider"]?.let { it as? JsonPrimitive }?.content ?: ""
        if (provider.isBlank()) return error("provider is required")
        val previous = session.get()
        if (previous != null) {
            return error("a login for '${previous.provider}' is already in progress — cancel it first")
        }
        val script = extractScript() ?: return error("cannot extract the pi-login helper (see idea.log)")
        val pi = PiLocator.locate()?.path ?: return error("pi CLI not found — set it up in Manage → Environment")
        val node = PiLocator.nodeInterpreterFor(pi)
            ?: return error("node interpreter not found for pi at $pi (terminal /login still works)")

        val command = OsProcess.launchCommand(listOf(node, script.absolutePath, pi))
        val pb = ProcessBuilder(command)
        // The helper mirrors its stderr chatter into protocol log lines; keep
        // stderr separate so nothing corrupts the JSON stream.
        PiLocator.nodeBinDirFor(pi)?.let { bin ->
            pb.environment()["PATH"] = bin + File.pathSeparator + (pb.environment()["PATH"] ?: "")
        }
        val proc = try {
            pb.start()
        } catch (e: Exception) {
            return error("cannot start the login helper: ${e.message}")
        }
        val writer = BufferedWriter(OutputStreamWriter(proc.outputStream, Charsets.UTF_8))
        val fresh = Session(project, provider, proc, writer)
        if (!session.compareAndSet(null, fresh)) {
            proc.descendants().forEach { it.destroyForcibly() }
            proc.destroyForcibly()
            return error("a login is already in progress — cancel it first")
        }
        startPumps(fresh)
        sendTo(fresh, buildJsonObject { put("t", "start"); put("provider", provider) })
        push(fresh, buildJsonObject { put("kind", "started"); put("provider", provider) })
        return buildJsonObject { put("ok", true) }
    }

    fun answer(params: JsonObject): JsonObject {
        val current = session.get() ?: return error("no login in progress")
        val id = params["id"]?.let { it as? JsonPrimitive }?.content?.toIntOrNull()
            ?: return error("prompt id is required")
        val value = params["value"]?.let { it as? JsonPrimitive }?.content ?: ""
        sendTo(current, buildJsonObject { put("t", "answer"); put("id", id); put("value", value) })
        return buildJsonObject { put("ok", true) }
    }

    fun cancel(): JsonObject {
        val current = session.get() ?: return buildJsonObject { put("ok", true); put("wasActive", false) }
        current.cancelRequested = true
        sendTo(current, buildJsonObject { put("t", "cancel") })
        // The helper exits on cancel; the tree kill is the orphan fallback.
        Thread {
            runCatching {
                Thread.sleep(3000)
                val proc = current.process
                if (proc.isAlive) {
                    proc.descendants().forEach { it.destroyForcibly() }
                    proc.destroyForcibly()
                }
            }
        }.apply { isDaemon = true }.start()
        return buildJsonObject { put("ok", true); put("wasActive", true) }
    }

    // -- pumps ----------------------------------------------------------------

    private fun startPumps(s: Session) {
        Thread {
            runCatching {
                s.process.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                    lines.forEach { handleLine(s, it) }
                }
            }.onFailure { LOG.warn("pi-login stdout pump failed", it) }
            finish(s, "stream closed")
        }.apply { isDaemon = true; name = "pi-login-stdout" }.start()
        Thread {
            runCatching {
                s.process.errorStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
                    lines.forEach { line ->
                        if (line.isNotBlank()) LOG.info("pi-login stderr: ${line.take(300)}")
                    }
                }
            }.onFailure { LOG.debug("pi-login stderr pump failed", it) }
        }.apply { isDaemon = true; name = "pi-login-stderr" }.start()
        s.process.onExit().thenRun {
            finish(s, "exit code ${s.process.exitValue()}")
        }
    }

    private fun handleLine(s: Session, raw: String) {
        when (val line = classify(raw)) {
            is Line.Ready -> LOG.info("pi-login helper ready (pi 1.4+ SDK import ok)")
            is Line.Event -> {
                val data = buildJsonObject {
                    put("kind", "event")
                    put("ev", line.ev)
                    val type = line.ev["type"]?.let { it as? JsonPrimitive }?.content
                    // Open the system browser for both redirect and device-code
                    // flows; the panel always mirrors the URL for copy/reuse.
                    val url = when (type) {
                        "auth_url" -> line.ev["url"]?.let { it as? JsonPrimitive }?.content
                        "device_code" -> line.ev["verificationUri"]?.let { it as? JsonPrimitive }?.content
                        else -> null
                    }
                    var opened = false
                    if (!url.isNullOrBlank()) {
                        opened = runCatching { BrowserUtil.browse(url); true }.getOrDefault(false)
                    }
                    put("browserOpened", opened)
                }
                push(s, data)
            }
            is Line.Prompt -> push(s, buildJsonObject {
                put("kind", "prompt")
                put("id", line.id)
                put("p", line.p)
            })
            is Line.Log -> LOG.info("pi-login: ${line.line.take(300)}")
            is Line.Done -> {
                s.sawDone = true
                push(s, buildJsonObject {
                    put("kind", "done")
                    put("ok", line.ok)
                    if (line.cancelled) put("cancelled", true)
                    line.provider?.let { put("provider", it) }
                    line.error?.let { put("error", it) }
                })
            }
            is Line.Unknown -> LOG.info("pi-login unparsable line: ${line.raw.take(120)}")
        }
    }

    /**
     * Terminal cleanup, idempotent: the helper prints its own done line for
     * every path it knows about; the exit watcher only speaks up when the
     * process died without one (crash, cancel-exit, parent kill).
     */
    private fun finish(s: Session, why: String) {
        runCatching { s.writer.close() }
        if (!session.compareAndSet(s, null)) return
        if (!s.sawDone) {
            push(s, buildJsonObject {
                put("kind", "done")
                put("ok", false)
                if (s.cancelRequested) put("cancelled", true)
                put(
                    "error",
                    when {
                        s.cancelRequested -> "login cancelled"
                        else -> "login helper $why"
                    },
                )
            })
        }
    }

    private fun sendTo(s: Session, msg: JsonObject) {
        try {
            synchronized(s.writer) {
                s.writer.write(msg.toString())
                s.writer.newLine()
                s.writer.flush()
            }
        } catch (e: Exception) {
            LOG.warn("pi-login: cannot write to helper (${e.message})")
        }
    }

    private fun push(s: Session, data: JsonObject) {
        runCatching {
            BridgeAccess.push(s.project, data)
        }.onFailure { LOG.warn("pi-login: cannot push event (${it.message})") }
    }

    private fun error(message: String): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", message)
    }
}

/**
 * Indirection so the object stays unit-testable without dragging the whole
 * BridgeService (a project service) into the test classpath.
 */
internal object BridgeAccess {
    internal var pushFn: (Project, JsonObject) -> Unit = { project, data ->
        val service = dev.pi.agent.bridge.BridgeService.getInstance(project)
        service.push(buildJsonObject {
            put("t", "event")
            put("name", "auth")
            put("data", data)
        })
    }

    fun push(project: Project, data: JsonObject) = pushFn(project, data)
}
