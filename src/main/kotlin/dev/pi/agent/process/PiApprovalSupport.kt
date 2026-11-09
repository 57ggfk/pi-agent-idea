package dev.pi.agent.process

import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File

/**
 * Installs the bundled pi-approve extension and manages its policy file.
 *
 * The extension is extracted to the IDE config dir and loaded with
 * `pi --extension <path>` so only plugin-launched pi processes are affected.
 * The policy JSON is re-read by the extension on every tool call, so writing
 * it switches approval behavior without restarting pi.
 */
object PiApprovalSupport {
    private val LOG = Logger.getInstance(PiApprovalSupport::class.java)

    // No leading slash: PluginClassLoader resolves root-relative paths and
    // rejects the "/..." form (plain ClassLoader semantics are the opposite).
    private const val EXTENSION_RESOURCE = "pi-approve/pi-approve.js"
    private const val EXTENSION_FILE_NAME = "pi-approve.js"
    private const val POLICY_FILE_NAME = "pi-approval-policy.json"

    const val MODE_ASK = "ask"
    const val MODE_YOLO = "yolo"

    /** Bumped when the *default* policy changes, so stored files can migrate. */
    private const val POLICY_VERSION = 2

    /** Fresh installs auto-approve: an IDE tool window should not ask on every edit. */
    private const val DEFAULT_MODE = MODE_YOLO

    /** Directory holding the extracted extension and the policy file. */
    fun agentDir(): File = File(PathManager.getConfigDir().toFile(), "pi-agent")

    /**
     * Extracts the bundled extension (overwritten on every start so upgrades
     * propagate) and makes sure the policy file exists. Returns the extension
     * file, or null when extraction failed (pi then runs without approval).
     */
    fun ensureExtensionInstalled(): File? {
        val target = try {
            val dir = agentDir()
            if (!dir.isDirectory && !dir.mkdirs()) {
                LOG.warn("cannot create pi-agent config dir: $dir")
                return null
            }
            val out = File(dir, EXTENSION_FILE_NAME)
            val resource = PiApprovalSupport::class.java.classLoader.getResourceAsStream(EXTENSION_RESOURCE)
            if (resource == null) {
                LOG.warn("pi-approve extension resource missing: $EXTENSION_RESOURCE")
                return null
            }
            resource.use { input -> out.outputStream().use { input.copyTo(it) } }
            out
        } catch (e: Exception) {
            LOG.warn("failed to install pi-approve extension", e)
            return null
        }
        runCatching { ensurePolicyFile() }
        return target
    }

    fun policyFile(): File = File(agentDir(), POLICY_FILE_NAME)

    /**
     * IDE 语言（`zh` / `en`），供 pi-approve 生成对话框文案。
     *
     * 扩展是在 pi 进程里跑的，读不到 IDE 的 Locale，也不会自己判断语言；
     * 插件在启动 pi 时用 `PI_APPROVE_LANG` 告诉它——不这么做，中文 IDE 里
     * 的审批标题永远是英文 `Allow bash?`。判定口径与前端一致
     * （BridgeService 的 `env.locale` 也用 `Locale.getDefault().language`）。
     */
    fun languageTag(): String = if (java.util.Locale.getDefault().language == "zh") "zh" else "en"

    /** Current policy as JSON; defaults when the file is missing or invalid. */
    fun policy(): JsonObject {
        val file = policyFile()
        val raw = runCatching { Json.parseToJsonElement(file.readText()).jsonObject }.getOrNull()
        val mode = raw?.get("mode")?.jsonPrimitive?.content
            ?.takeIf { it == MODE_ASK || it == MODE_YOLO } ?: DEFAULT_MODE
        val allow = raw?.get("allow")?.jsonArray
            ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
            ?: emptyList()
        return buildJsonObject {
            put("version", POLICY_VERSION)
            put("mode", mode)
            put("allow", buildJsonArray { allow.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
        }
    }

    /** Writes the policy; effective for the next tool call (no restart). */
    fun writePolicy(mode: String, allow: List<String>) {
        require(mode == MODE_ASK || mode == MODE_YOLO) { "unknown approval mode: $mode" }
        val file = policyFile()
        file.parentFile.mkdirs()
        file.writeText(
            buildJsonObject {
                put("version", POLICY_VERSION)
                put("mode", mode)
                put("allow", buildJsonArray { allow.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
            }.toString(),
        )
    }

    /**
     * Seeds (or migrates) the policy file.
     *
     * Files without a `version` were written by releases that defaulted to
     * "ask" for everyone, so their stored mode is the old default rather than a
     * user decision — those adopt the current default once. Files written from
     * [POLICY_VERSION] on keep whatever the user picked.
     */
    private fun ensurePolicyFile() {
        val file = policyFile()
        val raw = runCatching { Json.parseToJsonElement(file.readText()).jsonObject }.getOrNull()
        if (raw == null) {
            writePolicy(DEFAULT_MODE, emptyList())
            return
        }
        val version = raw["version"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0
        if (version >= POLICY_VERSION) return
        val allow = raw["allow"]?.jsonArray
            ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
            ?: emptyList()
        writePolicy(DEFAULT_MODE, allow)
    }
}
