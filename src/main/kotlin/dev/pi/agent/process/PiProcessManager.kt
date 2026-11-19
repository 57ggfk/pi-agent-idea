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
import java.util.concurrent.ConcurrentHashMap
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
 * One pi instance's mutable state (019 D1). Everything that used to be a
 * field on [PiProcessManager] lives here so a project can host N independent
 * `pi --mode rpc` processes (one per tool-window Content).
 */
private class InstanceSlot(val id: Int) {
    val processRef = AtomicReference<Process?>(null)
    val clientRef = AtomicReference<PiRpcClient?>(null)
    val stateListeners = CopyOnWriteArrayList<(PiConnectionState) -> Unit>()
    val eventListeners = CopyOnWriteArrayList<(JsonObject) -> Unit>()

    @Volatile var state: PiConnectionState = PiConnectionState.NotStarted

    @Volatile var stderrTail: String = ""

    @Volatile var pendingApprove = false
}

/**
 * Owns the per-project `pi --mode rpc` child processes and their [PiRpcClient]s.
 *
 * 019: the manager hosts an instance **registry** (`instanceId → InstanceSlot`,
 * ids from 1) instead of a single process pair. Every pre-existing method is a
 * facade over instance 1 (019 D2), so single-instance callers are unchanged;
 * the multi-instance path uses the [instanceId] overloads.
 *
 * Processes intentionally outlive tool window visibility so agent tasks keep
 * running in the background; they are terminated when the project closes.
 */
@Service(Service.Level.PROJECT)
class PiProcessManager(private val project: Project) : Disposable {

    private val LOG = Logger.getInstance(PiProcessManager::class.java)

    private val slots = ConcurrentHashMap<Int, InstanceSlot>()

    /** The slot for [id], created on demand (facade target = 1). */
    private fun slot(id: Int = 1): InstanceSlot = slots.computeIfAbsent(id) { InstanceSlot(it) }

    /** Facade: instance 1's connection state (pre-019 callers read this). */
    val state: PiConnectionState
        get() = slot(1).state

    /** One instance's connection state (019 D4 callers). */
    fun stateOf(instanceId: Int = 1): PiConnectionState = slot(instanceId).state

    /** Smallest unused instance id ≥ 1 (019 D1). */
    fun nextInstanceId(): Int {
        var n = 1
        while (slots.containsKey(n)) n++
        return n
    }

    /** Live instance ids, ascending. */
    fun liveInstanceIds(): List<Int> = slots.keys.toIntArray().sorted().toList()

    /** Stops one instance's process and drops its slot (019 D7 close path). */
    fun stopInstance(instanceId: Int) {
        slots.remove(instanceId)?.let { slot ->
            slot.clientRef.getAndSet(null)?.close()
            shutdownProcessOf(slot, keepState = false)
        }
    }

    fun addStateListener(instanceId: Int = 1, listener: (PiConnectionState) -> Unit) {
        val slot = slot(instanceId)
        slot.stateListeners.add(listener)
        listener(slot.state)
    }

    fun addEventListener(instanceId: Int = 1, listener: (JsonObject) -> Unit) {
        slot(instanceId).eventListeners.add(listener)
    }

    fun removeStateListener(instanceId: Int = 1, listener: (PiConnectionState) -> Unit) =
        slot(instanceId).stateListeners.remove(listener)

    fun removeEventListener(instanceId: Int = 1, listener: (JsonObject) -> Unit) =
        slot(instanceId).eventListeners.remove(listener)

    /** Returns the running client of [instanceId], starting it if necessary. */
    @Synchronized
    fun client(instanceId: Int = 1): PiRpcClient? = start(instanceId)

    @Synchronized
    fun start(instanceId: Int = 1): PiRpcClient? {
        val slot = slot(instanceId)
        synchronized(slot) {
            slot.clientRef.get()?.let { return it }

            val installation = PiLocator.locate()
            if (installation == null) {
                setSlotState(slot, PiConnectionState.Exited("pi executable not found on this machine", null))
                return null
            }

            setSlotState(slot, PiConnectionState.Starting(installation))
            val cwd = project.basePath ?: System.getProperty("user.home")

            // Extensions: the approval extension and the model-reload extension
            // are extracted per start so upgrades propagate. The approval policy
            // file is re-read per tool call, so toggling never needs a restart.
            // When extraction fails pi simply runs without that extension.
            val piArgs = PiStartArgs.build(
                // Resume the user's last model choice (persisted on set_model).
                model = PiModelPreferences.getInstance(project).get(),
                extensions = listOfNotNull(
                    PiApprovalSupport.ensureExtensionInstalled()?.absolutePath,
                    PiModelReload.ensureExtensionInstalled()?.absolutePath,
                    PiIdeEnvExtension.ensureExtensionInstalled()?.absolutePath,
                ),
                approveProjectFiles = consumeApproveOnNextStart(slot),
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
                LOG.warn("failed to start pi at ${installation.path}: ${command.joinToString(" ")}", e)
                setSlotState(slot, PiConnectionState.Exited("failed to start pi: ${e.message}", null))
                return null
            }

            slot.processRef.set(process)
            slot.stderrTail = ""
            Thread({ drainStderr(process, slot) }, "pi-rpc-stderr-$instanceId").apply { isDaemon = true; start() }

            val client = PiRpcClient(process, object : PiRpcListener {
                override fun onEvent(event: JsonObject) {
                    slot.eventListeners.forEach { it(event) }
                }

                override fun onClosed(message: String) {
                    // Give the process a moment to exit so we can read its code.
                    var exitCode: Int? = null
                    try {
                        exitCode = if (process.waitFor(2, TimeUnit.SECONDS)) process.exitValue() else null
                    } catch (_: InterruptedException) {
                    }
                    val tail = slot.stderrTail
                    val detail = buildString {
                        append(message)
                        if (exitCode != null && exitCode != 0) append(" (exit code $exitCode)")
                    }
                    setSlotState(slot, PiConnectionState.Exited(detail, tail.ifBlank { null }))
                    slot.clientRef.set(null)
                    slot.processRef.set(null)
                }
            })
            slot.clientRef.set(client)
            setSlotState(slot, PiConnectionState.Running(installation))
            // 032: 首次采集放后台线程（FR-009 不占 EDT），让第一轮对话就有环境事实；
            // 之后每轮 prompt 转发前都会刷新，无需这里再管。
            com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                runCatching { dev.pi.agent.manage.PiIdeEnv.refreshSnapshot(project) }
            }
            return client
        }
    }

    @Volatile
    private var drainThreads: MutableList<Thread> = mutableListOf()

    private fun drainStderr(process: Process, slot: InstanceSlot) {
        try {
            val reader = process.errorStream.bufferedReader(Charsets.UTF_8)
            val sb = StringBuilder()
            var line = reader.readLine()
            while (line != null) {
                LOG.info("[pi stderr] $line")
                synchronized(slot) {
                    sb.appendLine(line)
                    if (sb.length > MAX_STDERR) {
                        sb.delete(0, sb.length - MAX_STDERR)
                    }
                    slot.stderrTail = sb.toString()
                }
                line = reader.readLine()
            }
        } catch (_: IOException) {
            // stream closed with the process
        }
    }

    /** Restarts one instance's process (used after a crash or a settings change). */
    @Synchronized
    fun restart(instanceId: Int = 1): PiRpcClient? {
        val slot = slot(instanceId)
        synchronized(slot) { shutdownProcessOf(slot, keepState = true) }
        return start(instanceId)
    }

    /**
     * Records that the user authorised this project's local files in this
     * session (they just granted trust in the panel). Only the *next* start
     * picks it up: a running process is never re-created behind the user's
     * back, and the flag is single-use.
     */
    fun approveOnNextStart(instanceId: Int = 1) {
        slot(instanceId).pendingApprove = true
    }

    private fun consumeApproveOnNextStart(slot: InstanceSlot): Boolean {
        if (!slot.pendingApprove) return false
        slot.pendingApprove = false
        return true
    }

    private fun setSlotState(slot: InstanceSlot, newState: PiConnectionState) {
        slot.state = newState
        slot.stateListeners.forEach { it(newState) }
    }

    private fun shutdownProcessOf(slot: InstanceSlot, keepState: Boolean) {
        slot.clientRef.getAndSet(null)?.close()
        val process = slot.processRef.getAndSet(null)
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
            setSlotState(slot, PiConnectionState.NotStarted)
        }
    }

    override fun dispose() {
        // 019 D12: every instance's process is stopped — no orphans.
        slots.values.forEach { slot ->
            shutdownProcessOf(slot, keepState = false)
            slot.stateListeners.clear()
            slot.eventListeners.clear()
        }
        slots.clear()
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
