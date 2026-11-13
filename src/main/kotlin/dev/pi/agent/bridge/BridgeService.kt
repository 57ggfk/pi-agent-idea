package dev.pi.agent.bridge

import com.intellij.ide.ui.LafManagerListener
import com.intellij.notification.Notification
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.JBColor
import com.intellij.util.ui.UIUtil
import dev.pi.agent.process.PiConnectionState
import dev.pi.agent.process.PiModelReload
import dev.pi.agent.process.PiProcessManager
import dev.pi.agent.rpc.PiRpcClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.future.await
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
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

    /**
     * Paths of the file/folder drag that just entered this window's browser
     * (spec 016). Filled by [PiAgentPanel][dev.pi.agent.toolwindow.PiAgentPanel]
     * from CEF's drag handler, drained by `files.takeDrop` when the composer
     * receives the HTML5 drop.
     */
    val ideFileDrop = IdeFileDrop()

    /** Mirror of pi's message queue (spec 005); per-project by construction. */
    private var messageQueueField: dev.pi.agent.queue.PiMessageQueue? = null

    private fun messageQueue(): dev.pi.agent.queue.PiMessageQueue =
        messageQueueField ?: dev.pi.agent.queue.PiMessageQueue(::queueRpc) { payload ->
            push(buildJsonObject {
                put("t", "event")
                put("name", "queue")
                put("data", payload)
            })
        }.also { messageQueueField = it }

    /** Blocking RPC sender for the queue executor (steer / follow_up / clear_queue). */
    private fun queueRpc(command: JsonObject): JsonObject {
        val client = PiProcessManager.getInstance(project).client()
            ?: throw IllegalStateException("pi process is not running")
        try {
            return client.send(command, timeoutMs = 15_000)
                .get(15, java.util.concurrent.TimeUnit.SECONDS)
                .raw
        } catch (e: java.util.concurrent.ExecutionException) {
            throw (e.cause ?: e)
        }
    }

    private val wiredLock = Any()
    private var piEventsWired = false
    private var themeEventsWired = false

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
                "sessions.search" -> sessionsSearch(params)
                "sessions.delete" -> sessionsDelete(params)
                "sessions.rename" -> sessionsRename(params)
                "sessions.fork" -> sessionsFork(params)
                "sessions.exportHtml" -> sessionsExportHtml(params)
                "title.generate" -> titleGenerate(params)
                "files.list" -> filesList(params)
                "files.relpath" -> filesRelPath(params)
                "files.takeDrop" -> filesTakeDrop()
                "ide.repaint" -> repaintBrowser()
                "ui.reload" -> uiReloaded(params)
                "ide.openFile" -> openFileInEditor(params)
                "ide.showFileDiff" -> showFileDiff(params)
                "ide.openTerminal" -> dev.pi.agent.bridge.PiIdeTerminal.open(
                    project,
                    (params["command"] as? JsonPrimitive)?.content ?: "",
                )
                "config.getLastModel" -> lastModel()
                "config.setLastModel" -> setLastModel(params)
                "config.getPrefs" -> getPrefs()
                "config.setPrefs" -> setPrefs(params)
                "approval.getPolicy" -> approvalGetPolicy()
                "approval.setPolicy" -> approvalSetPolicy(params)
                "rpc.restart" -> restartPi()
                // spec 017: re-read the model catalog after a credential or
                // models.json write, without restarting pi (session intact).
                "models.reload" -> reloadModels()
                "manage.env" -> dev.pi.agent.manage.PiManage.environment()
                "manage.envDetect" -> dev.pi.agent.manage.PiEnvironment.detect()
                // 032 Q6-b: the read-only "what would be injected" viewer.
                "manage.envSnapshot" -> dev.pi.agent.manage.PiIdeEnv.refreshSnapshot(project)
                "manage.envInstall" ->
                    if ((params["method"] as? kotlinx.serialization.json.JsonPrimitive)?.content == dev.pi.agent.manage.PiEnvironment.SOURCE_SCRIPT) {
                        dev.pi.agent.manage.PiEnvironment.installScript()
                    } else {
                        dev.pi.agent.manage.PiEnvironment.install(
                            source = (params["source"] as? kotlinx.serialization.json.JsonPrimitive)?.content,
                            customRegistry = (params["registry"] as? kotlinx.serialization.json.JsonPrimitive)?.content,
                        )
                    }
                "manage.envCancelInstall" -> dev.pi.agent.manage.PiEnvironment.cancelInstall()
                "manage.envSetPath" -> dev.pi.agent.manage.PiEnvironment.setPiPath(params)
                // 028: the vendor script install + the explicit Node path.
                "manage.envSetNodePath" -> dev.pi.agent.manage.PiEnvironment.setNodePath(params)
                "manage.mcpList" -> dev.pi.agent.manage.PiManage.mcpList(project.basePath)
                "manage.mcpAdd" -> dev.pi.agent.manage.PiManage.mcpAdd(withProjectPath(params))
                "manage.mcpRemove" -> dev.pi.agent.manage.PiManage.mcpRemove(withProjectPath(params))
                "manage.mcpSetEnabled" -> dev.pi.agent.manage.PiManage.mcpSetEnabled(withProjectPath(params))
                "manage.mcpLogin" -> dev.pi.agent.manage.PiManage.mcpLogin(params)
                "manage.mcpLogout" -> dev.pi.agent.manage.PiManage.mcpLogout(params)
                "manage.packagesList" -> dev.pi.agent.manage.PiManage.packagesList()
                "manage.packageInstall" -> dev.pi.agent.manage.PiManage.packageInstall(params)
                "manage.packageRemove" -> dev.pi.agent.manage.PiManage.packageRemove(params)
                // 033: version check and gallery search; the broken single-package
                // `pi update <source>` RPC is gone (FR-004) — upgrades are
                // version-pinned installs issued by the frontend.
                "manage.packageCheck" -> dev.pi.agent.manage.PiManage.packageCheck(params)
                "manage.marketSearch" -> dev.pi.agent.manage.PiManage.marketSearch(params)
                "manage.packageUpdateAll" -> dev.pi.agent.manage.PiManage.packageUpdateAll(params)
                "manage.envUpdate" -> dev.pi.agent.manage.PiManage.envUpdate()
                "manage.modelsReadProvider" -> dev.pi.agent.manage.PiManage.modelsReadProvider(params)
                "manage.providerGet" -> dev.pi.agent.manage.PiModels.providerGet(params)
                "manage.providerSave" -> providerSaveWithReload(params)
                "manage.providerDelete" -> dev.pi.agent.manage.PiModels.providerDelete(params)
                "manage.providerTest" -> dev.pi.agent.manage.PiModels.providerTest(params)
                "manage.modelsOpenFile" -> modelsOpenFile(params)
                "ide.saveImage" -> IdeImageActions.saveImage(project, params)
                "ide.copyImage" -> IdeImageActions.copyImage(params)
                "manage.agentsList" -> dev.pi.agent.manage.PiAgents.list(project.basePath)
                "manage.agentsOpen" -> dev.pi.agent.manage.PiAgents.open(project, project.basePath, params)
                "manage.agentsCreate" -> dev.pi.agent.manage.PiAgents.create(project.basePath, params)
                "manage.skillsList" -> dev.pi.agent.manage.PiManage.skillsList(project.basePath)
                "manage.skillCreate" -> dev.pi.agent.manage.PiManage.skillCreate(params)
                "manage.authOverview" -> dev.pi.agent.manage.PiManage.authOverview()
                "manage.authCheck" -> dev.pi.agent.manage.PiManage.authCheck(params)
                "manage.authSet" -> dev.pi.agent.manage.PiCredentials.authSet(params)
                "manage.authDelete" -> dev.pi.agent.manage.PiCredentials.authDelete(params)
                "manage.providerSetKey" -> dev.pi.agent.manage.PiCredentials.providerSetKey(params)
                // spec 014: browser OAuth via the pi-login helper (one at a time).
                "manage.authLoginStart" -> dev.pi.agent.manage.PiLoginSupport.start(project, params)
                "manage.authLoginAnswer" -> dev.pi.agent.manage.PiLoginSupport.answer(params)
                "manage.authLoginCancel" -> dev.pi.agent.manage.PiLoginSupport.cancel()
                "manage.settingsRead" -> dev.pi.agent.manage.PiManage.settingsRead()
                "manage.settingsWrite" -> dev.pi.agent.manage.PiManage.settingsWrite(params)
                "trust.get" -> trustGet()
                "trust.grant" -> trustGrant(params)
                "trust.revoke" -> trustRevoke(params)
                "queue.get" -> messageQueue().handle("get", params)
                "queue.enqueue" -> messageQueue().handle("enqueue", params)
                "queue.move" -> messageQueue().handle("move", params)
                "queue.remove" -> messageQueue().handle("remove", params)
                "queue.restore" -> messageQueue().handle("restore", params)
                "queue.promote" -> messageQueue().handle("promote", params)
                "queue.pause" -> messageQueue().handle("pause", params)
                "queue.resume" -> messageQueue().handle("resume", params)
                "queue.clear" -> messageQueue().handle("clear", params)
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
        put("theme", currentTheme())
        put("editorFontFamily", UIUtil.getLabelFont().family)
        // Spec 008 US1: the IDE's language. Locale.getDefault() reflects the
        // IDE language pack (not the OS), which is exactly the "follow the
        // IDE" source; the web side matches it against its registry.
        put("locale", java.util.Locale.getDefault().language)
    }

    private fun currentTheme(): String = if (JBColor.isBright()) "light" else "dark"

    /**
     * Adds the project root to management params that need it: `--local` MCP
     * edits and `mcp.setEnabled` resolve `.pi/mcp.json` against the project, and
     * the frontend has no reliable way to know that path.
     */
    private fun withProjectPath(params: JsonObject): JsonObject {
        val base = project.basePath?.takeIf { it.isNotBlank() } ?: return params
        if (params.containsKey("projectPath")) return params
        return JsonObject(params.toMutableMap().apply { put("projectPath", JsonPrimitive(base)) })
    }

    private suspend fun rpcRequest(params: JsonObject): JsonObject {
        val command = params["command"] as? JsonObject
            ?: throw IllegalArgumentException("rpc.request requires command object")
        // 032 US4: every user turn refreshes the env snapshot BEFORE the prompt
        // reaches pi, so the extension (which re-reads the file on each
        // before_agent_start) injects facts collected seconds ago — an SDK
        // change applies without restarting pi. Collection is ReadAction-only
        // plus cached values (FR-009), and must never break the send.
        if (command["type"]?.jsonPrimitive?.contentOrNull == "prompt") {
            runCatching { dev.pi.agent.manage.PiIdeEnv.refreshSnapshot(project) }
                .onFailure { LOG.warn("env snapshot refresh failed (prompt continues): ${it.message}") }
        }
        // extension_ui_response is a sub-protocol NOTIFICATION: pi resolves the
        // pending dialog by the id inside and never replies. Sending it through
        // the correlated send() wraps it in a request id and pi never resolves
        // the dialog (verified against the official rpc-extension-ui client,
        // which writes the bare record to stdin).
        if (command["type"]?.jsonPrimitive?.contentOrNull == "extension_ui_response") {
            val client: PiRpcClient = PiProcessManager.getInstance(project).client()
                ?: throw IllegalStateException("pi process is not running")
            if (!client.notify(command)) throw IllegalStateException("pi process is not running")
            return buildJsonObject { put("success", true) }
        }
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

    /** Serializes catalog reloads: saving two providers must not refresh twice at once. */
    private val modelsReloadLock = Mutex()

    /**
     * Re-reads pi's model catalog (spec 017).
     *
     * pi picks up auth.json on its own, but a models.json change only enters the
     * availability snapshot after `ModelRuntime.refresh()` — and RPC mode has no
     * refresh command. The bundled pi-models extension registers one
     * (`pi-agent-reload-models`) whose handler awaits that refresh, so pi
     * answering "handled" already means the snapshot is rebuilt.
     *
     * When the command is missing (extraction failed, older pi) the list is
     * still re-read and `refreshed=false` lets the UI degrade without an error.
     */
    private suspend fun reloadModels(): JsonObject = modelsReloadLock.withLock {
        val client: PiRpcClient = PiProcessManager.getInstance(project).client()
            ?: throw IllegalStateException("pi process is not running")

        suspend fun request(command: JsonObject, timeoutMs: Long) =
            client.send(command, timeoutMs = timeoutMs).await()

        val commands = request(buildJsonObject { put("type", "get_commands") }, 10_000)
        val refreshed = PiModelReload.COMMAND in commandNames(commands.data)
        if (refreshed) {
            val answer = request(
                buildJsonObject {
                    put("type", "prompt")
                    put("message", "/${PiModelReload.COMMAND}")
                },
                30_000,
            )
            if (!answer.success) {
                throw IllegalStateException(answer.error ?: "model reload was rejected by pi")
            }
        }

        val models = request(buildJsonObject { put("type", "get_available_models") }, 15_000)
        if (!models.success) {
            throw IllegalStateException(models.error ?: "get_available_models failed")
        }
        val list = ((models.data as? JsonObject)?.get("models") as? JsonArray) ?: JsonArray(emptyList())
        buildJsonObject {
            put("models", list)
            put("refreshed", refreshed)
        }
    }

    /** Defensive read of a `get_commands` payload: a malformed shape means "none". */
    private fun commandNames(data: JsonElement?): Set<String> =
        ((data as? JsonObject)?.get("commands") as? JsonArray)
            ?.mapNotNull { entry -> ((entry as? JsonObject)?.get("name") as? JsonPrimitive)?.contentOrNull }
            ?.toSet()
            ?: emptySet()

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

    // -- UI preferences & tool-approval policy -------------------------------

    /** Preferences pi does not expose via get_state; restored by the frontend. */
    private fun getPrefs(): JsonObject {
        val prefs = dev.pi.agent.process.PiUserPrefs.getInstance(project)
        val autoRetry = prefs.autoRetry()
        val themePreference = prefs.themePreference()
        val languagePreference = prefs.languagePreference()
        return buildJsonObject {
            if (autoRetry != null) put("autoRetry", autoRetry)
            if (themePreference != null) put("theme", themePreference)
            if (languagePreference != null) put("language", languagePreference)
            // 033 FR-016: explicit npm registry override; absent = follow npm.
            prefs.registryOverride()?.let { put("registryOverride", it) }
        }
    }

    private fun setPrefs(params: JsonObject): JsonObject {
        val prefs = dev.pi.agent.process.PiUserPrefs.getInstance(project)
        val autoRetry = (params["autoRetry"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull()
        if (autoRetry != null) prefs.setAutoRetry(autoRetry)
        val themePreference = (params["theme"] as? JsonPrimitive)?.content
        if (themePreference != null) prefs.setThemePreference(themePreference)
        val languagePreference = (params["language"] as? JsonPrimitive)?.content
        if (languagePreference != null) prefs.setLanguagePreference(languagePreference)
        // The key present with a null/blank value clears the override; a value
        // that cannot be a registry URL is refused by storing "follow npm"
        // instead — the frontend shows the reason, the backend stays sane.
        if (params.containsKey("registryOverride")) {
            val raw = params["registryOverride"] as? JsonPrimitive
            val normalized = raw?.content?.let { dev.pi.agent.manage.PiEnvironment.normalizeCustomRegistry(it) }
            prefs.setRegistryOverride(normalized)
        }
        return buildJsonObject { put("ok", true) }
    }

    private fun approvalGetPolicy(): JsonObject =
        dev.pi.agent.process.PiApprovalSupport.policy()

    // -- project trust ------------------------------------------------------

    /**
     * Project-level files (skills, mcp, settings, extensions) are inert until
     * pi finds the project in `trust.json`. The frontend cannot see that file,
     * so the state has to come from here.
     *
     * The project is taken from the bridge's per-project routing, never from
     * the request: a frontend must not be able to ask about another project.
     */
    private fun trustGet(): JsonObject {
        val basePath = project.basePath ?: ""
        val snapshot = dev.pi.agent.process.PiTrust.snapshot(basePath)
        val resources = dev.pi.agent.process.PiTrust.resources(basePath, snapshot.trusted)
        return buildJsonObject {
            // An unreadable store is reported as a failed read: the frontend
            // must show it rather than pretend the project is untrusted.
            put("ok", snapshot.error == null)
            snapshot.error?.let { put("error", it) }
            put("trusted", snapshot.trusted)
            put("path", if (basePath.isBlank()) "" else dev.pi.agent.process.PiTrust.normalize(basePath))
            put("store", snapshot.file)
            put("exists", snapshot.exists)
            put("resources", buildJsonArray {
                resources.forEach { resource ->
                    add(buildJsonObject {
                        put("type", resource.type)
                        put("label", resource.label)
                        put("scope", resource.scope)
                        put("active", resource.active)
                        put("path", resource.path)
                        resource.reason?.let { put("reason", it) }
                    })
                }
            })
        }
    }

    private fun trustGrant(params: JsonObject): JsonObject {
        if (!confirmed(params)) {
            return buildJsonObject { put("ok", false); put("error", "confirmation required") }
        }
        val basePath = project.basePath
            ?: return buildJsonObject { put("ok", false); put("error", "project has no base path") }
        val result = dev.pi.agent.process.PiTrust.grant(basePath)
        if (!result.ok) {
            return buildJsonObject {
                put("ok", false)
                put("error", result.error ?: "write failed")
                put("trusted", false)
            }
        }
        val manager = PiProcessManager.getInstance(project)
        // A running process keeps the trust state it started with; the flag
        // only affects the next start, and only because the user just
        // authorised this project in this session.
        manager.approveOnNextStart()
        return buildJsonObject {
            put("ok", true)
            put("trusted", true)
            put("path", dev.pi.agent.process.PiTrust.normalize(basePath))
            put("restartRequired", manager.state !is PiConnectionState.NotStarted)
        }
    }

    private fun trustRevoke(params: JsonObject): JsonObject {
        if (!confirmed(params)) {
            return buildJsonObject { put("ok", false); put("error", "confirmation required") }
        }
        val basePath = project.basePath
            ?: return buildJsonObject { put("ok", false); put("error", "project has no base path") }
        val result = dev.pi.agent.process.PiTrust.revoke(basePath)
        if (!result.ok) {
            return buildJsonObject { put("ok", false); put("error", result.error ?: "write failed") }
        }
        val manager = PiProcessManager.getInstance(project)
        return buildJsonObject {
            put("ok", true)
            put("trusted", false)
            put("path", dev.pi.agent.process.PiTrust.normalize(basePath))
            put("restartRequired", manager.state !is PiConnectionState.NotStarted)
        }
    }

    private fun confirmed(params: JsonObject): Boolean =
        (params["confirmed"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() == true

    /** Writes the approval policy; the extension re-reads it on every tool call. */
    private fun approvalSetPolicy(params: JsonObject): JsonObject {
        val mode = (params["mode"] as? JsonPrimitive)?.content
            ?: throw IllegalArgumentException("approval.setPolicy requires mode")
        val allow = (params["allow"] as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.content }
            ?: emptyList()
        dev.pi.agent.process.PiApprovalSupport.writePolicy(mode, allow)
        return buildJsonObject { put("ok", true) }
    }

    /**
     * 027 FR-006: after a successful provider write, refresh the running pi's
     * model catalog through the 017 in-process path. A failed reload must not
     * roll the file back — the response carries `reloaded:false` plus the
     * error, and the UI says "saved; takes effect after the tool window
     * restarts".
     */
    private suspend fun providerSaveWithReload(params: JsonObject): JsonObject {
        val saved = dev.pi.agent.manage.PiModels.providerSave(params)
        val ok = (saved["ok"] as? JsonPrimitive)?.booleanOrNull == true
        if (!ok) return saved
        return try {
            val reload = reloadModels()
            buildJsonObject {
                saved.forEach { (k, v) -> put(k, v) }
                put("reloaded", true)
                put("models", reload["models"] ?: JsonArray(emptyList()))
            }
        } catch (e: Exception) {
            buildJsonObject {
                saved.forEach { (k, v) -> put(k, v) }
                put("reloaded", false)
                put("reloadError", e.message ?: e.javaClass.simpleName)
            }
        }
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
                        put("messageCount", s.messageCount)
                    })
                }
            })
        }
    }

    private fun sessionsDelete(params: JsonObject): JsonObject {
        val file = params["file"]?.let { it as? JsonPrimitive }?.content
            ?: throw IllegalArgumentException("sessions.delete requires file")
        dev.pi.agent.session.PiSessionIndex.deleteSessionFile(file)
        return buildJsonObject { put("ok", true) }
    }

    /**
     * Renames a session that is NOT the live one (the live session goes
     * through pi's `set_session_name` RPC): appends a `session_info` entry
     * to the file, exactly the record pi itself writes on rename.
     */
    private fun sessionsRename(params: JsonObject): JsonObject {
        val file = params["file"]?.let { it as? JsonPrimitive }?.content
            ?: throw IllegalArgumentException("sessions.rename requires file")
        val name = params["name"]?.let { it as? JsonPrimitive }?.content
            ?: throw IllegalArgumentException("sessions.rename requires name")
        dev.pi.agent.session.PiSessionIndex.renameSessionFile(file, name)
        return buildJsonObject { put("ok", true) }
    }

    /**
     * 024: full-copy fork of a non-live session — a one-shot
     * `pi --mode rpc --fork <file>` process (see PiSessionFork for the probe
     * backing this shape). The response is the new file path only; the
     * caller applies the (fork) title suffix offline via sessions.rename.
     */
    private fun sessionsFork(params: JsonObject): JsonObject {
        val file = params["file"]?.let { it as? JsonPrimitive }?.content
            ?: throw IllegalArgumentException("sessions.fork requires file")
        val forked = dev.pi.agent.session.PiSessionFork.forkSession(project.basePath, file)
        return buildJsonObject {
            put("ok", true)
            put("file", forked.file)
        }
    }

    /**
     * B-stage title generation (the web store drives it after the first
     * assistant reply): a one-shot pi process summarizes the first exchange.
     * Best-effort — errors come back as data and the caller keeps the
     * heuristic title, so nothing here needs to throw.
     */
    private fun titleGenerate(params: JsonObject): JsonObject {
        val user = params["user"]?.let { it as? JsonPrimitive }?.content
            ?: throw IllegalArgumentException("title.generate requires user")
        val assistant = params["assistant"]?.let { it as? JsonPrimitive }?.content ?: ""
        val provider = params["provider"]?.let { it as? JsonPrimitive }?.content
        val modelId = params["modelId"]?.let { it as? JsonPrimitive }?.content
        val state = PiProcessManager.getInstance(project).state
        val path = when (state) {
            is PiConnectionState.Starting -> state.installation.path
            is PiConnectionState.Running -> state.installation.path
            else -> throw IllegalStateException("pi is not available")
        }
        return dev.pi.agent.title.TitleGenerator.generate(path, user, assistant, provider, modelId)
    }

    /**
     * Full-text search across the project's session files (spec 006 US3).
     * Runs on the IO dispatcher via the bridge scope; the scan itself is
     * line-streamed and capped (see [searchSessions]).
     */
    private fun sessionsSearch(params: JsonObject): JsonObject {
        val query = (params["query"] as? JsonPrimitive)?.content
            ?: throw IllegalArgumentException("sessions.search requires query")
        val outcome = dev.pi.agent.session.searchSessions(project.basePath ?: "", query)
        return buildJsonObject {
            put("results", buildJsonArray {
                outcome.results.forEach { r ->
                    add(buildJsonObject {
                        put("file", r.file)
                        put("id", r.id ?: "")
                        put("name", r.name ?: "")
                        put("modifiedAt", r.modifiedAt)
                        put("hitCount", r.hitCount)
                        put("hits", buildJsonArray {
                            r.hits.forEach { h ->
                                add(buildJsonObject {
                                    put("role", h.role)
                                    put("snippet", h.snippet)
                                    put("hitIndex", h.hitIndex)
                                })
                            }
                        })
                    })
                }
            })
            put("scanned", outcome.scanned)
            put("truncated", outcome.truncated)
        }
    }

    private suspend fun sessionsExportHtml(params: JsonObject): JsonObject {
        val file = params["file"]?.let { it as? JsonPrimitive }?.content
            ?: throw IllegalArgumentException("sessions.exportHtml requires file")
        val sessionFile = dev.pi.agent.session.PiSessionIndex.sessionFileFor(file)
        val rendered = kotlinx.coroutines.withContext(Dispatchers.IO) {
            dev.pi.agent.session.SessionHtmlExporter.render(sessionFile)
        }

        // The save dialog must run on the EDT; the handler is on Dispatchers.IO.
        val savedPath = kotlinx.coroutines.CompletableDeferred<String?>()
        ApplicationManager.getApplication().invokeLater {
            try {
                val descriptor = FileSaverDescriptor(
                    dev.pi.agent.PiAgentBundle.message("export.dialog.title"),
                    dev.pi.agent.PiAgentBundle.message("export.dialog.description"),
                    "html",
                )
                val wrapper = FileChooserFactory.getInstance()
                    .createSaveFileDialog(descriptor, project)
                    .save(rendered.suggestedFileName)
                val target = wrapper?.file
                if (target == null) {
                    savedPath.complete(null)
                    return@invokeLater
                }
                // Plain file write: the wrapper only carries the chosen path.
                target.writeText(rendered.html)
                savedPath.complete(target.path)
            } catch (e: Exception) {
                savedPath.completeExceptionally(e)
            }
        }
        val path = savedPath.await()
            ?: return buildJsonObject { put("ok", true); put("cancelled", true) }

        NotificationGroupManager.getInstance()
            .getNotificationGroup("Pi Agent")
            .createNotification(
                dev.pi.agent.PiAgentBundle.message("export.done.title"),
                dev.pi.agent.PiAgentBundle.message("export.done.body", path),
                NotificationType.INFORMATION,
            )
            .notify(project)
        return buildJsonObject { put("ok", true); put("path", path) }
    }

    // -- IDE integration ----------------------------------------------------

    /** Relative source paths for @-completions (cached, capped, excluded dirs filtered). */
    private fun filesList(params: JsonObject): JsonObject {
        // The menu's ↻ Refresh must see files created seconds ago: `force`
        // bypasses the 30s server-side cache (a cached refresh would make the
        // button a lie — found by the real-machine pass).
        val force = (params["force"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() == true
        val files = projectFilesCached(force)
        return buildJsonObject {
            put("files", buildJsonArray {
                files.forEach { add(it) }
            })
        }
    }

    @Volatile
    private var filesCache: Pair<Long, List<String>>? = null

    private fun projectFilesCached(force: Boolean = false): List<String> {
        val now = System.currentTimeMillis()
        if (!force) filesCache?.let { (at, files) -> if (now - at < FILES_TTL_MS) return files }
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
    /**
     * Full-frame CEF invalidation (0.5.4 real-machine find: JCEF OSR could
     * keep a stale frame on screen for seconds-to-minutes after the frontend
     * switched views; the DOM was already correct). Best-effort: when the
     * tool window was never opened there is no browser to invalidate.
     */
    private fun repaintBrowser(): JsonObject {
        val content = com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
            .getToolWindow("Pi Agent")?.contentManager?.getContent(0)?.component ?: return ok(true)
        val panel = generateSequence(content as java.awt.Component) { it.parent }
            .filterIsInstance<dev.pi.agent.toolwindow.PiAgentPanel>()
            .firstOrNull()
        panel?.repaintBrowser()
        return ok(true)
    }

    private fun ok(value: Boolean): JsonObject = buildJsonObject { put("ok", value) }

    /**
     * The frontend's watchdog is about to reload the page because its long-poll
     * stopped succeeding. Trace only — this is the log line that makes a
     * self-heal distinguishable from "the plugin did nothing" (CEF's own log is
     * disabled by the platform, so there is no other record of it).
     */
    private fun uiReloaded(params: JsonObject): JsonObject {
        val silentMs = (params["silentMs"] as? JsonPrimitive)?.contentOrNull ?: "?"
        LOG.warn("UI watchdog: page reloading after ${silentMs}ms without a successful poll")
        return ok(true)
    }

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
        if (tool !in VfsRefresh.EDIT_TOOLS) return
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

    /**
     * Opens models.json in the editor, navigating to the provider's line
     * (spec 001 FR-012). The skeleton is created only when the file is absent;
     * an existing file is opened as-is even when it does not parse.
     */
    private fun modelsOpenFile(params: JsonObject): JsonObject {
        val provider = (params["provider"] as? JsonPrimitive)?.content
        val outcome = dev.pi.agent.manage.PiManage.modelsEnsureFile()
        if (outcome.error != null) throw IllegalStateException(outcome.error)
        val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByIoFile(outcome.file)
            ?: throw IllegalStateException("file not found: ${outcome.file.absolutePath}")
        val line = dev.pi.agent.manage.PiManage.modelsProviderLine(outcome.file, provider)
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            com.intellij.openapi.fileEditor.OpenFileDescriptor(project, vf, line - 1, 0).navigate(true)
        }
        return buildJsonObject {
            put("ok", true)
            put("path", outcome.file.absolutePath)
            put("created", outcome.created)
        }
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
            maybeScheduleVfsRefresh(event)
            notifyIfSettledInBackground(event)
            // spec 005: pi's queue events drive the mirror; an aborted run
            // parks it (abort's queue behaviour must not be relied upon).
            messageQueue().onPiEvent(event)
            val settledAborted = (event["aborted"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull()
            if (event["type"]?.jsonPrimitive?.contentOrNull == "agent_settled" && settledAborted == true) {
                messageQueue().onAborted()
            }
        }
        manager.addStateListener { state ->
            pushStateEvent(state)
            // A fresh pi process starts with an empty queue: park a non-empty
            // mirror as paused instead of letting it be silently forgotten.
            if (state is PiConnectionState.Running) messageQueue().onProcessRestarted()
        }
        pushStateEvent(manager.state)
        wireThemeEvents()
    }

    private fun wireThemeEvents() {
        synchronized(wiredLock) {
            if (themeEventsWired) return
            themeEventsWired = true
        }
        val connection = ApplicationManager.getApplication().messageBus.connect(this)
        connection.subscribe(LafManagerListener.TOPIC, LafManagerListener { _ ->
            push(buildJsonObject {
                put("t", "event")
                put("name", "theme")
                put("data", buildJsonObject { put("theme", currentTheme()) })
            })
        })
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
            .createNotification(
                dev.pi.agent.PiAgentBundle.message("notify.finished.title"),
                dev.pi.agent.PiAgentBundle.message("notify.finished.body", project.name),
                NotificationType.INFORMATION,
            )
        notification.addAction(object : AnAction(dev.pi.agent.PiAgentBundle.message("notify.finished.action")) {
            override fun actionPerformed(e: AnActionEvent) {
                toolWindow?.activate(null)
                notification.expire()
            }
        })
        notification.notify(project)
    }

    // -- VFS refresh after pi writes (spec 009 US4) --------------------------

    /**
     * Debounced VFS refresh for pi's write-class tool calls (FR-011/FR-012):
     * path-level refresh for named files, whole-project for shell tools and
     * at every settle. Read-only tools never get here (pure logic in
     * [VfsRefresh]). The Alarm coalesces bursts into one refresh.
     */
    private val vfsRefreshAlarm = com.intellij.util.Alarm(
        com.intellij.util.Alarm.ThreadToUse.POOLED_THREAD, this,
    )
    private val refreshLock = Any()
    private val pendingRefreshPaths = LinkedHashSet<String>()
    private var pendingWholeRefresh = false

    @Volatile
    private var lastWholeRefreshAt = 0L

    private fun maybeScheduleVfsRefresh(event: JsonObject) {
        val type = event["type"]?.jsonPrimitive?.contentOrNull ?: return
        if (type == "agent_settled") {
            // Whole-project refresh settles the round and covers files bash
            // touched without naming them (rate-limited: FR-011 + plan risk).
            if (System.currentTimeMillis() - lastWholeRefreshAt >= WHOLE_REFRESH_MIN_INTERVAL_MS) {
                synchronized(refreshLock) { pendingWholeRefresh = true }
                scheduleVfsRefresh()
            }
            return
        }
        if (type != "tool_execution_end") return
        val tool = event["toolName"]?.jsonPrimitive?.contentOrNull ?: return
        val paths = VfsRefresh.pathsForEvent(tool, event["args"] as? JsonObject)
        synchronized(refreshLock) {
            if (paths == null) pendingWholeRefresh = true else pendingRefreshPaths.addAll(paths)
        }
        scheduleVfsRefresh()
    }

    private fun scheduleVfsRefresh() {
        vfsRefreshAlarm.cancelAllRequests()
        vfsRefreshAlarm.addRequest({ flushVfsRefresh() }, VFS_REFRESH_DEBOUNCE_MS)
    }

    private fun flushVfsRefresh() {
        val paths: List<String>
        val whole: Boolean
        synchronized(refreshLock) {
            whole = pendingWholeRefresh
            paths = pendingRefreshPaths.toList()
            pendingWholeRefresh = false
            pendingRefreshPaths.clear()
        }
        if (!whole && paths.isEmpty()) return
        val lfs = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
        val onFinish = Runnable { invalidateFilesCache() }
        if (whole) {
            val root = project.basePath?.let { java.io.File(it) } ?: return
            lastWholeRefreshAt = System.currentTimeMillis()
            lfs.refreshIoFiles(listOf(root), true, true, onFinish)
        } else {
            val ioFiles = paths.mapNotNull { toVfsRefreshPath(it) }
            if (ioFiles.isEmpty()) return
            lfs.refreshIoFiles(ioFiles, true, true, onFinish)
        }
        // No paths in the log: tool arguments can embed user content.
        LOG.info("vfs-refresh: whole=$whole paths=${paths.size}")
    }

    /**
     * The IO file to refresh for a pi tool path argument. A file pi just
     * created is not in the VFS yet, so its parent directory is refreshed
     * instead — that makes the new child appear in the project view.
     */
    private fun toVfsRefreshPath(path: String): java.io.File? {
        val io = resolveIoFile(path) ?: return null
        return if (io.exists()) io else io.parentFile
    }

    /** Clears the @-completion file cache so new files show up immediately (FR-013). */
    internal fun invalidateFilesCache() {
        filesCache = null
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

    /**
     * Milliseconds since this project's frontend last long-polled, or
     * [Long.MAX_VALUE] if it never has. Used by the panel to notice that its
     * embedded browser stopped running the page.
     */
    fun sinceFrontendPollMs(): Long = transport.sinceLastPollMs()

    /** Lazily wires pi event listeners on first frontend contact. */
    fun ensureWired() {
        wirePiEvents()
    }

    /**
     * Injects a prompt drafted by IDE editor actions (Explain/Fix/Send with Pi)
     * into the frontend composer. Pushed as an `ide` event. [refs] (spec 015)
     * rides on the same event so the composer gets the reference chips and the
     * prompt text atomically — two separate events would race the store.
     */
    fun pushIdePrompt(text: String, refs: List<Pair<String, Boolean>> = emptyList()) {
        // Ensure a pi process exists and the frontend gets state events.
        wirePiEvents()
        PiProcessManager.getInstance(project).client()
        push(buildJsonObject {
            put("t", "event")
            put("name", "ide")
            put("data", buildJsonObject {
                put("kind", "prompt")
                put("text", text)
                if (refs.isNotEmpty()) {
                    put("files", ideRefArray(refs))
                }
            })
        })
    }

    /** `files` payload shared by pushIdePrompt / pushIdeRefs: (path, isDirectory). */
    private fun ideRefArray(refs: List<Pair<String, Boolean>>) = buildJsonArray {
        refs.forEach { (path, dir) ->
            add(buildJsonObject {
                put("path", path)
                put("dir", dir)
            })
        }
    }

    /**
     * Injects file/directory references (spec 015) drafted by the file-popup
     * actions ("Add Directory / Send File to Pi") into the frontend composer,
     * where they become removable chips. Only the path ever travels — pi
     * resolves `@path` references itself at send time. Pushed as an `ide`
     * event with kind "refs"; [refs] pairs are (project-relative path, isDirectory).
     *
     * [fromDrop] marks the spec-016 fallback: the page never received an HTML5
     * drop, so the IDE pushed the batch itself. The composer uses that flag to
     * suppress its DataTransfer fallback and avoid a duplicate chip.
     */
    fun pushIdeRefs(refs: List<Pair<String, Boolean>>, fromDrop: Boolean = false) {
        if (refs.isEmpty()) return
        wirePiEvents()
        PiProcessManager.getInstance(project).client()
        push(buildJsonObject {
            put("t", "event")
            put("name", "ide")
            put("data", buildJsonObject {
                put("kind", "refs")
                put("files", ideRefArray(refs))
                if (fromDrop) put("fromDrop", true)
            })
        })
    }

    /**
     * Resolves dropped / pasted paths (spec 015) for the composer chips:
     * absolute paths inside the project become project-relative, and the
     * directory flag is confirmed against the real filesystem so a dropped
     * folder shows the folder icon. Paths outside the project come back
     * unchanged — pi reads absolute paths too.
     */
    private fun filesRelPath(params: JsonObject): JsonObject {
        val inputs = params["paths"] as? kotlinx.serialization.json.JsonArray ?: kotlinx.serialization.json.JsonArray(emptyList())
        val pairs = ArrayList<Pair<String, Boolean>>(inputs.size)
        for (item in inputs) {
            val obj = item as? JsonObject ?: continue
            val raw = (obj["path"] as? JsonPrimitive)?.content ?: ""
            val hintDir = (obj["dir"] as? JsonPrimitive)?.booleanOrNull == true
            pairs.add(raw to hintDir)
        }
        return buildJsonObject { put("refs", refsJson(DropRefs.resolve(projectRoot(), pairs))) }
    }

    /**
     * Hands the composer the real paths of the file/folder drag that just
     * entered the browser (spec 016). The HTML5 drop event only carries bare
     * file names, so without this the chip would show `a.kt` with no directory
     * — pi could not `@`-resolve it. One-shot: the buffer is drained here.
     */
    private fun filesTakeDrop(): JsonObject {
        val paths = ideFileDrop.take()
        val refs = if (paths.isEmpty()) emptyList() else DropRefs.resolve(projectRoot(), paths.map { it to false })
        // 真机诊断：一次都没出现这条，说明页面根本没派发 HTML5 drop。
        LOG.info("Pi Agent takeDrop: ${paths.size} path(s) -> ${refs.size} ref(s)")
        return buildJsonObject { put("refs", refsJson(refs)) }
    }

    private fun refsJson(refs: List<DropRef>) = buildJsonArray {
        refs.forEach { ref ->
            add(buildJsonObject {
                put("path", ref.path)
                put("dir", ref.dir)
            })
        }
    }

    private fun projectRoot(): java.nio.file.Path? =
        project.basePath?.let { runCatching { java.nio.file.Path.of(it) }.getOrNull() }

    override fun dispose() {
        messageQueueField?.shutdown()
        scope.cancel()
    }

    companion object {
        private const val FILES_TTL_MS = 30_000L
        private const val MAX_FILES = 5000
        private const val VFS_REFRESH_DEBOUNCE_MS = 400L
        private const val WHOLE_REFRESH_MIN_INTERVAL_MS = 2_000L
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
