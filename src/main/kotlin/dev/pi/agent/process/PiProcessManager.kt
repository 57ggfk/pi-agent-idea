package dev.pi.agent.process

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import dev.pi.agent.rpc.PiRpcClient
import dev.pi.agent.rpc.PiRpcListener
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Lifecycle state of the per-project pi RPC process. */
sealed class PiConnectionState {
    data object NotStarted : PiConnectionState()
    data class Starting(val installation: PiInstallation) : PiConnectionState()
    data class Running(val installation: PiInstallation) : PiConnectionState()
    data class Exited(val message: String, val stderrTail: String?) : PiConnectionState()
}

/**
 * Assembled start arguments, extracted so the trust branch is testable
 * without an IDE project (see `PiStartArgsTest`).
 */
internal object PiStartArgs {

    /**
     * @param model last-used provider/model pair, restored on start
     * @param extensions absolute paths passed as repeated `--extension` flags;
     *   the approval extension and the model-reload extension (spec 017) both
     *   ride along, and an empty list means neither could be extracted
     * @param approveProjectFiles append `--approve`: honoured only for a start
     *   the user explicitly authorised in this session
     */
    fun build(
        model: Pair<String, String>?,
        extensions: List<String>,
        approveProjectFiles: Boolean,
    ): List<String> = buildList {
        add("--mode")
        add("rpc")
        model?.let { (provider, name) ->
            add("--provider")
            add(provider)
            add("--model")
            add(name)
        }
        extensions.forEach {
            add("--extension")
            add(it)
        }
        if (approveProjectFiles) add("--approve")
    }
}

/**
 * Owns the per-project `pi --mode rpc` child process and its [PiRpcClient].
 *
 * The process intentionally outlives tool window visibility so agent tasks keep
 * running in the background; it is terminated when the project closes.
 */
@Service(Service.Level.PROJECT)
class PiProcessManager(private val project: Project) : Disposable {    private val LOG = Logger.getInstance(PiProcessManager::class.java)

    private val processRef = AtomicReference<Process?>(null)
    private val clientRef = AtomicReference<PiRpcClient?>(null)

    @Volatile
    var state: PiConnectionState = PiConnectionState.NotStarted
        private set

    private val stateListeners = CopyOnWriteArrayList<(PiConnectionState) -> Unit>()
    private val eventListeners = CopyOnWriteArrayList<(JsonObject) -> Unit>()

    fun addStateListener(listener: (PiConnectionState) -> Unit) {
        stateListeners.add(listener)
        listener(state)
    }

    fun addEventListener(listener: (JsonObject) -> Unit) {
        eventListeners.add(listener)
    }

    fun removeStateListener(listener: (PiConnectionState) -> Unit) = stateListeners.remove(listener)

    fun removeEventListener(listener: (JsonObject) -> Unit) = eventListeners.remove(listener)

    /** Returns the running client, starting the process if necessary. */
    @Synchronized
    fun client(): PiRpcClient? {
        clientRef.get()?.let { return it }
        return start()
    }

    @Synchronized
    fun start(): PiRpcClient? {
        val existing = clientRef.get()
        if (existing != null) return existing

        val installation = PiLocator.locate()
        if (installation == null) {
            setState(PiConnectionState.Exited("pi executable not found on this machine", null))
            return null
        }

        setState(PiConnectionState.Starting(installation))
        val cwd = project.basePath ?: System.getProperty("user.home")

        // Extensions: the approval extension and the model-reload extension are
        // extracted per start so upgrades propagate. The approval policy file is
        // re-read per tool call, so toggling never needs a restart. When
        // extraction fails pi simply runs without that extension.
        val piArgs = PiStartArgs.build(
            // Resume the user's last model choice (persisted on set_model).
            model = PiModelPreferences.getInstance(project).get(),
            extensions = listOfNotNull(
                PiApprovalSupport.ensureExtensionInstalled()?.absolutePath,
                PiModelReload.ensureExtensionInstalled()?.absolutePath,
                PiIdeEnvExtension.ensureExtensionInstalled()?.absolutePath,
            ),
            approveProjectFiles = consumeApproveOnNextStart(),
        )
        val command = PiLocator.spawnCommand(installation.path, piArgs)

        val pb = ProcessBuilder(command)
        pb.directory(File(cwd))
        pb.redirectErrorStream(false)
        // The node interpreter next to pi (GUI-launched IDEs have neither
        // node nor nvm in their PATH; pi and its MCP servers need both).
        OsProcess.augmentPathEnv(pb, buildList {
            PiLocator.nodeBinDirFor(installation.path)?.let { add(it) }
            addAll(PiLocator.loginShellPath())
        })
        pb.environment()["PI_APPROVE_POLICY"] = PiApprovalSupport.policyFile().absolutePath
        // pi-approve 在 pi 进程里跑，只有插件知道 IDE 是中文还是英文。
        pb.environment()["PI_APPROVE_LANG"] = PiApprovalSupport.languageTag()
        // 032 FR-005: 差量补齐构建相关环境变量（只增不改），并把快照路径交给
        // pi-env 扩展——扩展每轮 before_agent_start 读它注入系统提示词。
        dev.pi.agent.manage.PiIdeEnv.applyToProcess(
            pb.environment(),
            System.getenv(),
            dev.pi.agent.manage.PiIdeEnv.snapshotFile().absolutePath,
        )

        val process: Process = try {
            pb.start()
        } catch (e: IOException) {
            // The command is part of the message: "Cannot run program" alone
            // does not say which interpreter or which PATH entry was used.
            LOG.warn("failed to start pi at ${installation.path}: ${command.joinToString(" ")}", e)
            setState(PiConnectionState.Exited("failed to start pi: ${e.message}", null))
            return null
        }

        processRef.set(process)
        stderrTail = ""
        Thread({ drainStderr(process) }, "pi-rpc-stderr").apply { isDaemon = true; start() }

        val client = PiRpcClient(process, object : PiRpcListener {
            override fun onEvent(event: JsonObject) {
                eventListeners.forEach { it(event) }
            }

            override fun onClosed(message: String) {
                // Give the process a moment to exit so we can read its code.
                var exitCode: Int? = null
                try {
                    exitCode = if (process.waitFor(2, TimeUnit.SECONDS)) process.exitValue() else null
                } catch (_: InterruptedException) {
                }
                val tail = stderrTail
                val detail = buildString {
                    append(message)
                    if (exitCode != null && exitCode != 0) append(" (exit code $exitCode)")
                }
                setState(PiConnectionState.Exited(detail, tail.ifBlank { null }))
                clientRef.set(null)
                processRef.set(null)
            }
        })
        clientRef.set(client)
        setState(PiConnectionState.Running(installation))
        // 032: 首次采集放后台线程（FR-009 不占 EDT），让第一轮对话就有环境事实；
        // 之后每轮 prompt 转发前都会刷新，无需这里再管。
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { dev.pi.agent.manage.PiIdeEnv.refreshSnapshot(project) }
        }
        return client
    }

    @Volatile
    private var stderrTail: String = ""

    private fun drainStderr(process: Process) {
        try {
            val reader = process.errorStream.bufferedReader(Charsets.UTF_8)
            val sb = StringBuilder()
            var line = reader.readLine()
            while (line != null) {
                LOG.info("[pi stderr] $line")
                synchronized(this) {
                    sb.appendLine(line)
                    if (sb.length > MAX_STDERR) {
                        sb.delete(0, sb.length - MAX_STDERR)
                    }
                    stderrTail = sb.toString()
                }
                line = reader.readLine()
            }
        } catch (_: IOException) {
            // stream closed with the process
        }
    }

    /** Restarts the process (used after a crash or a settings change). */
    @Synchronized
    fun restart(): PiRpcClient? {
        shutdownProcess(keepState = true)
        return start()
    }

    /**
     * Records that the user authorised this project's local files in this
     * session (they just granted trust in the panel). Only the *next* start
     * picks it up: a running process is never re-created behind the user's
     * back, and the flag is single-use.
     */
    fun approveOnNextStart() {
        pendingApprove = true
    }

    @Volatile
    private var pendingApprove = false

    private fun consumeApproveOnNextStart(): Boolean {
        if (!pendingApprove) return false
        pendingApprove = false
        return true
    }

    private fun setState(newState: PiConnectionState) {
        state = newState
        stateListeners.forEach { it(newState) }
    }

    private fun shutdownProcess(keepState: Boolean) {
        clientRef.getAndSet(null)?.close()
        val process = processRef.getAndSet(null)
        if (process != null && process.isAlive) {
            process.destroy()
            try {
                if (!process.waitFor(5, TimeUnit.SECONDS)) {
                    process.destroyForcibly()
                }
            } catch (_: InterruptedException) {
                process.destroyForcibly()
            }
        }
        if (!keepState) {
            setState(PiConnectionState.NotStarted)
        }
    }

    override fun dispose() {
        shutdownProcess(keepState = false)
        stateListeners.clear()
        eventListeners.clear()
    }

    init {
        Disposer.register(project, this)
    }

    companion object {
        private const val MAX_STDERR = 4096

        @JvmStatic
        fun getInstance(project: Project): PiProcessManager = project.getService(PiProcessManager::class.java)
    }
}
