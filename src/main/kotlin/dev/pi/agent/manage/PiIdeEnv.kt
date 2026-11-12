package dev.pi.agent.manage

import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import dev.pi.agent.manage.PiEnvSnapshot.Tier
import dev.pi.agent.process.PiApprovalSupport
import dev.pi.agent.process.PiLocator
import dev.pi.agent.settings.PiAgentSettings
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

/**
 * Per-project state for [PiIdeEnv]: everything that must be probed ONCE and
 * then reused verbatim on every per-turn refresh (FR-009 — the hot path never
 * spawns a process), plus the last rendered snapshot for the viewer.
 */
@Service(Service.Level.PROJECT)
class PiIdeEnvState {
    /** One-time `node -v` answer for the fallback node path; never re-probed. */
    @Volatile
    var nodeVersion: String? = null

    @Volatile
    var nodeProbed: Boolean = false

    /** Login-shell PATH captured at first collection (TTL-cached upstream). */
    @Volatile
    var shellPathDirs: List<String>? = null

    /** Debounce marker so two rapid prompts do not re-render twice. */
    @Volatile
    var lastRefreshMs: Long = 0

    @Volatile
    var lastText: String = ""

    @Volatile
    var lastCollectedAt: String = ""

    @Volatile
    var lastEnabled: Boolean = true
}

/**
 * Collects the IDE's build/run environment (spec 032, tiers A + B + the Node
 * extension tier), renders it into a plain-text snapshot, and keeps that
 * snapshot on disk for the pi-env extension to append to pi's system prompt on
 * every agent start — which is how an SDK change reaches pi WITHOUT a restart
 * (US4: the file is re-written before every `prompt` RPC is forwarded, and the
 * extension re-reads it on every turn).
 *
 * Degradation rules (FR-001): every tier is individually optional and wrapped
 * in runCatching — a missing plugin (no JS plugin in plain IDEA), a missing
 * SDK, a missing extension point all render as "absent", never as an error.
 *
 * Security (FR-006/US6): environment variables pass the whitelist + blacklist
 * double filter in [PiEnvSnapshot] before they can appear anywhere — snapshot
 * text, bridge response, logs. There is no code path around it.
 */
object PiIdeEnv {
    private val LOG = Logger.getInstance(PiIdeEnv::class.java)
    private val json = Json { prettyPrint = true }

    /** Snapshot file lives in the IDE config dir next to the extensions — pi can read it, the project repo never sees it. */
    fun snapshotFile(): File = File(PiApprovalSupport.agentDir(), "pi-ide-env.json")

    /** Candidate classes for the Node interpreter manager (JS plugin, optional). */
    internal val NODE_MANAGER_CANDIDATES =
        listOf(
            "com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager",
            "org.jetbrains.plugins.nodejs.interpreter.NodeJsInterpreterManager",
        )

    // ---------------------------------------------------------------------
    // Pure tier builders (unit-tested without an IDE; PiIdeEnv only gathers
    // the raw primitives the IDE offers and hands them in).
    // ---------------------------------------------------------------------

    /** A-tier facts: the project SDK and (when the Java plugin parts exist) the language level. */
    fun sdkTier(sdkName: String?, sdkVersion: String?, sdkHome: String?, languageLevel: String?): Tier? {
        if (sdkName == null && sdkVersion == null && sdkHome == null && languageLevel == null) return null
        val lines = buildList {
            if (sdkName != null) {
                val version = sdkVersion?.takeIf { it.isNotBlank() }
                add("Project SDK: $sdkName${version?.let { " ($it)" } ?: ""}")
            }
            if (sdkHome != null) add("SDK home: $sdkHome")
            if (languageLevel != null) add("Java language level: $languageLevel")
        }
        if (lines.isEmpty()) return null
        return Tier("sdk", "Project SDK", lines)
    }

    /**
     * Node extension tier: prefer the project-configured interpreter (JS
     * plugin, reflective), fall back to the node found on PATH (no version
     * re-probe). Absent when neither offers anything (US5 degrade).
     */
    fun nodeTier(
        reflectedHome: String?,
        fallbackNodePath: String?,
        fallbackNodeVersion: String?,
    ): Tier? {
        val lines = buildList {
            if (reflectedHome != null) add("Project Node interpreter home: $reflectedHome (from the JS plugin)")
            if (fallbackNodePath != null) {
                val version = fallbackNodeVersion?.takeIf { it.isNotBlank() }
                add("Node on PATH: $fallbackNodePath${version?.let { " (v$it)" } ?: ""}")
            }
        }
        if (lines.isEmpty()) return null
        return Tier("node-sdk", "Node interpreter", lines)
    }

    /** B-tier facts: whitelisted build variables and the cached login-shell PATH. */
    fun envTier(filteredEnv: Map<String, String>, shellPathDirs: List<String>?): Tier? {
        val lines = buildList {
            filteredEnv.forEach { (name, value) -> add("$name=$value") }
            val dirs = shellPathDirs.orEmpty()
            if (dirs.isNotEmpty()) {
                add("Login shell PATH dirs: ${dirs.take(12).joinToString(", ")}")
                if (dirs.size > 12) add("… and ${dirs.size - 12} more")
            }
        }
        if (lines.isEmpty()) return null
        return Tier("shell-env", "Build-relevant environment", lines)
    }

    // ---------------------------------------------------------------------
    // IDE-side collection (never spawns a process: SDK via ReadAction, node
    // version probed once and cached, shell PATH cached at first collection).
    // ---------------------------------------------------------------------

    /** Reflects the JS plugin's Node interpreter manager; null when absent or shaped unexpectedly. */
    internal fun reflectNodeInterpreterHome(project: Project): String? =
        NODE_MANAGER_CANDIDATES.firstNotNullOfOrNull { className ->
            runCatching {
                val cls = Class.forName(className)
                val manager = cls.getMethod("getInstance", Project::class.java).invoke(null, project) ?: return@runCatching null
                val interpreter =
                    cls.methods
                        .firstOrNull { it.name == "getCurrentInterpreter" && it.parameterCount == 0 }
                        ?.invoke(manager)
                val home = interpreter
                    ?.javaClass
                    ?.methods
                    ?.firstOrNull { it.name == "getInterpreterHomePath" && it.parameterCount == 0 }
                    ?.invoke(interpreter) as? String
                home?.takeIf { it.isNotBlank() }
            }.getOrNull()
        }

    /**
     * Collects every tier that answers. `envSource` and `nodeProbe` are
     * injectable so tests can feed a fake environment; production uses
     * `System.getenv()` and a one-time cached `node -v`.
     */
    fun collectTiers(
        project: Project,
        state: PiIdeEnvState,
        envSource: Map<String, String> = System.getenv(),
        nodeProber: (String) -> String? = ::probeNodeVersion,
        basePath: String? = project.basePath,
    ): List<Tier> {
        // A-tier: project SDK (all three IDEs) + Java language level when the
        // class exists (WebStorm has no Java plugin parts → skipped, US5).
        val (sdkName, sdkVersion, sdkHome) = runCatching {
            ReadAction.compute<Array<String?>, Exception> {
                val sdk = ProjectRootManager.getInstance(project).projectSdk
                arrayOf(sdk?.name, sdk?.versionString, sdk?.homePath)
            }
        }.getOrDefault(arrayOfNulls<String>(3))

        // The Java language level lives in the Java plugin's parts of the
        // platform (absent in WebStorm) — reflect and degrade (FR-001).
        val languageLevel = runCatching {
            ReadAction.compute<String?, Exception> {
                val ext =
                    Class
                        .forName("com.intellij.pom.java.LanguageLevelProjectExtension")
                        .getMethod("getInstance", Project::class.java)
                        .invoke(null, project)
                ext.javaClass.methods
                    .firstOrNull { it.name == "getCurrent" && it.parameterCount == 0 }
                    ?.invoke(ext)
                    ?.toString()
            }
        }.getOrNull()

        val tiers = mutableListOf<Tier>()
        sdkTier(sdkName, sdkVersion, sdkHome, languageLevel)?.let { tiers.add(it) }

        // Node tier: reflected project interpreter first, PATH node as fallback.
        val reflected = runCatching { reflectNodeInterpreterHome(project) }.getOrNull()
        val fallbackNode = runCatching { PiLocator.locateNode() }.getOrNull()
        if (fallbackNode != null && !state.nodeProbed) {
            state.nodeVersion = runCatching { nodeProber(fallbackNode) }.getOrNull()
            state.nodeProbed = true
        }
        nodeTier(reflected, fallbackNode, state.nodeVersion)?.let { tiers.add(it) }

        // B-tier: whitelisted environment variables + cached login-shell PATH.
        if (state.shellPathDirs == null) {
            state.shellPathDirs = runCatching { PiLocator.loginShellPath() }.getOrNull().orEmpty()
        }
        envTier(PiEnvSnapshot.filterEnvVars(envSource), state.shellPathDirs)?.let { tiers.add(it) }

        return tiers
    }

    /** One-time `node -v` (FR-009: only ever at first collection, then cached). */
    fun probeNodeVersion(nodePath: String): String? =
        runCatching {
            val parent = File(nodePath).parentFile?.absolutePath
            val pb = ProcessBuilder(listOf(nodePath, "-v")).redirectErrorStream(true)
            parent?.let { dev.pi.agent.process.OsProcess.augmentPathEnv(pb, listOf(it)) }
            val result = dev.pi.agent.manage.PiCliRunner.runProcess(pb, 15)
            (result.stdout + result.stderr).trim().lineSequence().firstOrNull { it.isNotBlank() }?.removePrefix("v")
        }.getOrNull()

    // ---------------------------------------------------------------------
    // Snapshot lifecycle: render → write → (extension reads per turn).
    // ---------------------------------------------------------------------

    /**
     * Re-collects and re-writes the snapshot file. Cheap enough to run before
     * every forwarded `prompt` (ReadAction only, no external processes) and
     * debounced so a rapid double-send renders once. Never throws — callers
     * additionally wrap it in runCatching, but the contract is non-null.
     */
    fun refreshSnapshot(project: Project): JsonObject {
        val state = project.getService(PiIdeEnvState::class.java)
        val now = System.currentTimeMillis()
        if (now - state.lastRefreshMs < REFRESH_DEBOUNCE_MS) return currentStatus(project)
        synchronized(state) {
            val again = System.currentTimeMillis()
            if (again - state.lastRefreshMs < REFRESH_DEBOUNCE_MS) return currentStatus(project)
            val enabled = runCatching { PiAgentSettings.getInstance().envContextEnabled() }.getOrDefault(true)
            val collectedAt = java.time.Instant.ofEpochMilli(again).toString()
            val tiers =
                runCatching { collectTiers(project, state) }
                    .onFailure { LOG.warn("env tier collection failed (degrading): ${it.message}") }
                    .getOrDefault(emptyList())
            val commands =
                runCatching { PiEnvSnapshot.suggestedCommands(buildMarkers(project.basePath)) }
                    .getOrDefault(emptyList())
            val text = PiEnvSnapshot.render(collectedAt, tiers, commands)

            state.lastText = text
            state.lastCollectedAt = collectedAt
            state.lastEnabled = enabled
            state.lastRefreshMs = again
            writeSnapshotFile(enabled, collectedAt, text)
            return currentStatus(project)
        }
    }

    /** Marker files that hint at the build stack (existence checks only). */
    internal fun buildMarkers(basePath: String?): List<String> {
        val root = basePath?.let(::File) ?: return emptyList()
        return BUILD_MARKERS.filter { File(root, it).isFile }
    }

    /** Writes the snapshot JSON; failures are logged and swallowed (FR-001). */
    private fun writeSnapshotFile(enabled: Boolean, collectedAt: String, text: String) {
        runCatching {
            val dir = PiApprovalSupport.agentDir()
            if (!dir.isDirectory && !dir.mkdirs()) {
                LOG.warn("cannot create pi-agent config dir for the env snapshot")
                return
            }
            val body = buildJsonObject {
                put("enabled", enabled)
                put("collectedAt", collectedAt)
                put("text", text)
            }
            snapshotFile().writeText(json.encodeToString(JsonObject.serializer(), body))
        }.onFailure { LOG.warn("failed to write the env snapshot: ${it.message}") }
    }

    /** FR-010: flipping the switch must reach pi without a restart. */
    fun onSettingChanged(project: Project) {
        val state = project.getService(PiIdeEnvState::class.java)
        val enabled = runCatching { PiAgentSettings.getInstance().envContextEnabled() }.getOrDefault(true)
        state.lastEnabled = enabled
        // Keep the last text so the viewer still shows what WOULD be injected;
        // the extension only honors the file when enabled=true.
        writeSnapshotFile(enabled, state.lastCollectedAt.ifEmpty { java.time.Instant.now().toString() }, state.lastText)
    }

    /** Bridge payload for the read-only viewer (Q6-b). */
    fun currentStatus(project: Project): JsonObject {
        val state = project.getService(PiIdeEnvState::class.java)
        // Prefer the in-memory render; fall back to the file so the viewer
        // still answers right after an IDE restart before any prompt ran.
        val onDisk = runCatching {
            val obj = Json.parseToJsonElement(snapshotFile().readText()) as? JsonObject
            obj?.get("collectedAt")?.let { it.toString().trim('"') } to (obj?.get("enabled")?.toString() == "true")
        }.getOrNull()
        val collectedAt = state.lastCollectedAt.ifEmpty { onDisk?.first ?: "" }
        return buildJsonObject {
            put("ok", true)
            put("enabled", if (state.lastRefreshMs > 0L) state.lastEnabled else (onDisk?.second ?: true))
            put("collectedAt", collectedAt)
            put("text", state.lastText)
            put("file", snapshotFile().absolutePath)
        }
    }

    // ---------------------------------------------------------------------
    // Subprocess environment (FR-005): diff-only additions, PI_IDE_ prefix for
    // plugin-owned variables. Testable without a project.
    // ---------------------------------------------------------------------

    /**
     * Adds the whitelisted build variables the IDE process has but the
     * subprocess does not, plus the snapshot path. Never overrides anything
     * already present (只增不改, same contract as OsProcess.augmentPathEnv).
     */
    fun applyToProcess(env: MutableMap<String, String>, source: Map<String, String>, snapshotPath: String) {
        PiEnvSnapshot.whitelistAdditions(env, source).forEach { (name, value) -> env[name] = value }
        env["PI_IDE_ENV_SNAPSHOT"] = snapshotPath
    }

    private const val REFRESH_DEBOUNCE_MS = 200L

    private val BUILD_MARKERS =
        listOf("pom.xml", "build.gradle.kts", "build.gradle", "package.json", "requirements.txt", "pyproject.toml")
}
