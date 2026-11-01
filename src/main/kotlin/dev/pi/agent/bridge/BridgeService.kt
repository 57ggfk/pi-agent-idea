package dev.pi.agent.bridge

import com.intellij.notification.Notification
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
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
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * Routes JSON-envelope messages between the web frontend and plugin services.
 *
 * Transport is HTTP on the loopback UI server (see [dev.pi.agent.ui.LocalUiServer]):
 * the frontend `POST`s `{t, id, p}` envelopes to `/bridge` and long-polls
 * `/bridge/poll` for responses (`t=resp`) and pushed events (`t=event`).
 */
@Service(Service.Level.PROJECT)
class BridgeService(private val project: Project) : Disposable {

    private val LOG = Logger.getInstance(BridgeService::class.java)
    private val json = Json { encodeDefaults = true }
    // IO (not Default): some handlers block for minutes (pi CLI management
    // commands) and must not starve the shared Default pool.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Per-project event buffer: separate IDE windows never share a stream. */
    private val transport = BridgeTransport()

    private val wiredLock = Any()
    private var piEventsWired = false

    /** Entry point for POST /bridge. Envelopes are handled asynchronously. */
    fun handleEnvelope(message: String) {
        scope.launch {
            val element = try {
                json.parseToJsonElement(message).jsonObject
            } catch (e: Exception) {
                // Do not log the envelope body: it can embed user conversation text.
                LOG.warn("bridge: malformed envelope (${message.length} chars)")
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
                "sessions.list" -> sessionsList()
                "files.list" -> filesList()
                "ide.openFile" -> openFileInEditor(params)
                "ide.showFileDiff" -> showFileDiff(params)
                "config.getLastModel" -> lastModel()
                "config.setLastModel" -> setLastModel(params)
                "rpc.restart" -> restartPi()
                "manage.env" -> dev.pi.agent.manage.PiManage.environment()
                "manage.mcpList" -> dev.pi.agent.manage.PiManage.mcpList()
                "manage.mcpAdd" -> dev.pi.agent.manage.PiManage.mcpAdd(params)
                "manage.mcpRemove" -> dev.pi.agent.manage.PiManage.mcpRemove(params)
                "manage.mcpLogin" -> dev.pi.agent.manage.PiManage.mcpLogin(params)
                "manage.mcpLogout" -> dev.pi.agent.manage.PiManage.mcpLogout(params)
                "manage.packagesList" -> dev.pi.agent.manage.PiManage.packagesList()
                "manage.packageInstall" -> dev.pi.agent.manage.PiManage.packageInstall(params)
                "manage.packageRemove" -> dev.pi.agent.manage.PiManage.packageRemove(params)
                "manage.skillsList" -> dev.pi.agent.manage.PiManage.skillsList()
                "manage.skillCreate" -> dev.pi.agent.manage.PiManage.skillCreate(params)
                "manage.authOverview" -> dev.pi.agent.manage.PiManage.authOverview()
                "manage.authCheck" -> dev.pi.agent.manage.PiManage.authCheck(params)
                "manage.settingsRead" -> dev.pi.agent.manage.PiManage.settingsRead()
                "manage.settingsWrite" -> dev.pi.agent.manage.PiManage.settingsWrite(params)
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
        val timeoutMs = (params["timeoutMs"] as? JsonPrimitive)?.content?.toLongOrNull()
            ?: PiRpcClient.DEFAULT_TIMEOUT_MS
        val client: PiRpcClient = PiProcessManager.getInstance(project).client()
            ?: throw IllegalStateException("pi process is not running")
        val response = client.send(command, timeoutMs = timeoutMs).await()
        return response.raw
    }

    /** Restarts the pi process after a crash or configuration change. */
    private fun restartPi(): JsonObject {
        PiProcessManager.getInstance(project).restart()
            ?: throw IllegalStateException("failed to restart pi (see logs)")
        return buildJsonObject { put("ok", true) }
    }

    private fun lastModel(): JsonObject {
        val prefs = dev.pi.agent.process.PiModelPreferences.getInstance(project).get()
        return buildJsonObject {
            put("provider", prefs?.first ?: "")
            put("model", prefs?.second ?: "")
        }
    }

    private fun setLastModel(params: JsonObject): JsonObject {
        val provider = (params["provider"] as? JsonPrimitive)?.content ?: ""
        val model = (params["model"] as? JsonPrimitive)?.content ?: ""
        if (provider.isNotBlank() && model.isNotBlank()) {
            dev.pi.agent.process.PiModelPreferences.getInstance(project).set(provider, model)
        }
        return buildJsonObject { put("ok", true) }
    }

    private fun sessionsList(): JsonObject {
        val sessions = dev.pi.agent.session.PiSessionIndex.list(project.basePath ?: "")
        return buildJsonObject {
            put("sessions", buildJsonArray {
                sessions.forEach { s ->
                    add(buildJsonObject {
                        put("file", s.file)
                        put("id", s.id ?: "")
                        put("timestamp", s.timestamp ?: "")
                        put("name", s.name ?: "")
                        put("preview", s.preview ?: "")
                        put("modifiedAt", s.modifiedAt)
                    })
                }
            })
        }
    }

    // -- IDE integration ----------------------------------------------------

    /** Relative source paths for @-completions (cached, capped, excluded dirs filtered). */
    private fun filesList(): JsonObject {
        val files = projectFilesCached()
        return buildJsonObject {
            put("files", buildJsonArray {
                files.forEach { add(it) }
            })
        }
    }

    @Volatile
    private var filesCache: Pair<Long, List<String>>? = null

    private fun projectFilesCached(): List<String> {
        val now = System.currentTimeMillis()
        filesCache?.let { (at, files) -> if (now - at < FILES_TTL_MS) return files }
        val root = project.basePath?.let { java.nio.file.Path.of(it) }
            ?: return emptyList()
        val index = com.intellij.openapi.roots.ProjectFileIndex.getInstance(project)
        val out = mutableListOf<String>()
        index.iterateContent { vf ->
            if (out.size >= MAX_FILES) return@iterateContent false
            if (vf.isDirectory || vf.fileType.isBinary) return@iterateContent true
            val rel = root.relativize(java.nio.file.Path.of(vf.path)).toString().replace('\\', '/')
            if (EXCLUDED_PATHS.none { rel.contains(it) }) out.add(rel)
            true
        }
        val sorted = out.sorted()
        filesCache = now to sorted
        return sorted
    }

    /** Opens a project-relative (or absolute) file at [line] in the editor. */
    private fun openFileInEditor(params: JsonObject): JsonObject {
        val path = (params["path"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("ide.openFile requires path")
        val line = ((params["line"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 1).coerceAtLeast(1)
        val vf = resolveFile(path)
            ?: throw IllegalArgumentException("file not found: $path")
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            com.intellij.openapi.fileEditor.OpenFileDescriptor(project, vf, line - 1, 0).navigate(true)
        }
        return buildJsonObject { put("ok", true) }
    }

    /**
     * Shows pi's changes to [path] in the native JetBrains diff window:
     * baseline (captured when pi started editing, or git HEAD as fallback)
     * vs. the current file content. Without any baseline it falls back to
     * opening the file.
     */
    private fun showFileDiff(params: JsonObject): JsonObject {
        val path = (params["path"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("ide.showFileDiff requires path")
        val vf = resolveFile(path)
            ?: throw IllegalArgumentException("file not found: $path")
        val before = baselineFor(path)
        if (before == null) {
            openFileInEditor(params)
            return buildJsonObject { put("ok", true); put("opened", true) }
        }
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            val after = try {
                com.intellij.diff.DiffContentFactory.getInstance().create(project, vf)
            } catch (e: Exception) {
                LOG.warn("diff: cannot read current content of ${vf.path}", e)
                return@invokeLater
            }
            val beforeContent = com.intellij.diff.DiffContentFactory.getInstance()
                .create(project, before, vf.fileType)
            val request = com.intellij.diff.requests.SimpleDiffRequest(
                "pi changes — ${vf.presentableName}",
                beforeContent,
                after,
                "Before pi",
                "After pi (current)",
            )
            com.intellij.diff.DiffManager.getInstance().showDiff(project, request)
        }
        return buildJsonObject { put("ok", true) }
    }

    /**
     * Pre-edit content for [path]: first-seen baseline captured when pi
     * started an edit tool on the file, else the git HEAD version.
     */
    private fun baselineFor(path: String): String? {
        synchronized(fileBaselineLock) {
            fileBaselines[path]?.let { return it }
        }
        return gitHeadContent(path)
    }

    private val fileBaselineLock = Any()
    private val fileBaselines = LinkedHashMap<String, String>()

    /**
     * Captures the pre-edit content of a file the moment pi announces an
     * edit/write tool on it (the event fires before the tool runs, so the
     * file on disk is still pristine). First snapshot wins so a multi-edit
     * turn keeps diffing against the original state.
     */
    private fun maybeCaptureBaseline(event: JsonObject) {
        if (event["type"]?.jsonPrimitive?.contentOrNull != "tool_execution_start") return
        val tool = event["toolName"]?.jsonPrimitive?.contentOrNull?.lowercase() ?: return
        if (tool !in EDIT_TOOLS) return
        val path = ((event["args"] as? JsonObject)?.get("path") as? JsonPrimitive)?.content
            ?.takeIf { it.isNotBlank() } ?: return
        synchronized(fileBaselineLock) {
            if (fileBaselines.containsKey(path)) return
            val file = resolveIoFile(path)
            val content = if (file == null || !file.isFile) "" // write creates a new file
            else runCatching {
                require(file.length() <= MAX_BASELINE_BYTES) { "too large" }
                file.readText()
            }.getOrNull() ?: return
            fileBaselines[path] = content
            while (fileBaselines.size > MAX_BASELINES) {
                fileBaselines.remove(fileBaselines.keys.first())
            }
        }
    }

    private fun resolveIoFile(path: String): java.io.File? {
        val expanded = if (path.startsWith("~/") || path.startsWith("~\\"))
            java.io.File(System.getProperty("user.home"), path.drop(2)).absolutePath
        else path
        val file = java.io.File(expanded)
        if (file.isAbsolute) return file
        val root = project.basePath ?: return null
        return java.io.File(root, expanded)
    }

    /** File content at git HEAD (best-effort, null when unavailable). */
    private fun gitHeadContent(path: String): String? {
        val root = project.basePath ?: return null
        val file = resolveIoFile(path) ?: return null
        val absolute = file.absolutePath
        val rootFile = java.io.File(root).absoluteFile
        val rel = runCatching { rootFile.toPath().relativize(java.io.File(absolute).toPath()).toString() }
            .getOrNull() ?: return null
        if (rel.startsWith("..")) return null
        return try {
            val proc = ProcessBuilder("git", "-C", root, "show", "HEAD:$rel")
                .redirectErrorStream(false)
                .start()
            val done = proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
            if (!done || proc.exitValue() != 0) {
                proc.destroyForcibly()
                null
            } else {
                proc.inputStream.bufferedReader().readText()
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun resolveFile(path: String): com.intellij.openapi.vfs.VirtualFile? {
        val io = resolveIoFile(path) ?: return null
        return com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByIoFile(io)
    }

    // -- push channel -------------------------------------------------------

    private fun wirePiEvents() {
        synchronized(wiredLock) {
            if (piEventsWired) return
            piEventsWired = true
        }
        val manager = PiProcessManager.getInstance(project)
        manager.addEventListener { event ->
            push(buildJsonObject {
                put("t", "event")
                put("name", "pi")
                put("data", event)
            })
            maybeCaptureBaseline(event)
            notifyIfSettledInBackground(event)
        }
        manager.addStateListener { state -> pushStateEvent(state) }
        pushStateEvent(manager.state)
    }

    /**
     * Fires a balloon notification when a background run settles while the
     * tool window is not visible (the user is working elsewhere in the IDE).
     */
    private fun notifyIfSettledInBackground(event: JsonObject) {
        if (event["type"]?.jsonPrimitive?.contentOrNull != "agent_settled") return
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("Pi Agent")
        if (toolWindow?.isVisible == true) return
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup("Pi Agent")
            .createNotification("Pi Agent finished", "The agent run completed in ${project.name}.", NotificationType.INFORMATION)
        notification.addAction(object : AnAction("Show Pi Agent") {
            override fun actionPerformed(e: AnActionEvent) {
                toolWindow?.activate(null)
                notification.expire()
            }
        })
        notification.notify(project)
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

    fun push(record: JsonObject) {
        transport.push(record)
    }

    /** Poll endpoint backend for this project's frontend. */
    fun pollEvents(cursor: Long, timeoutMs: Long): List<BridgeTransport.Entry> = transport.pollAfter(cursor, timeoutMs)

    fun currentSeq(): Long = transport.currentSeq()

    /** Lowest buffered sequence; a frontend cursor below it has missed events. */
    fun oldestSeq(): Long = transport.oldestSeq()

    /** Lazily wires pi event listeners on first frontend contact. */
    fun ensureWired() {
        wirePiEvents()
    }

    /**
     * Injects a prompt drafted by IDE editor actions (Explain/Fix/Send with Pi)
     * into the frontend composer. Pushed as an `ide` event.
     */
    fun pushIdePrompt(text: String) {
        // Ensure a pi process exists and the frontend gets state events.
        wirePiEvents()
        PiProcessManager.getInstance(project).client()
        push(buildJsonObject {
            put("t", "event")
            put("name", "ide")
            put("data", buildJsonObject {
                put("kind", "prompt")
                put("text", text)
            })
        })
    }

    override fun dispose() {
        scope.cancel()
    }

    companion object {
        private const val FILES_TTL_MS = 30_000L
        private const val MAX_FILES = 5000
        /** Tools that mutate files; used to snapshot pre-edit baselines for diffing. */
        private val EDIT_TOOLS = setOf("edit", "write", "multiedit", "str_replace", "str_replace_editor", "apply_patch")
        private const val MAX_BASELINES = 50
        private const val MAX_BASELINE_BYTES = 2L * 1024 * 1024
        private val EXCLUDED_PATHS = listOf(
            "/node_modules/", "/build/", "/target/", "/dist/", "/out/",
            "/.git/", "/.idea/", "/.gradle/", "/vendor/",
        )

        @JvmStatic
        fun getInstance(project: Project): BridgeService = project.getService(BridgeService::class.java)
    }
}
