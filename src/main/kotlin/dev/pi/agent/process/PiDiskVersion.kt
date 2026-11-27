package dev.pi.agent.process

import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

/**
 * The version of pi that is **on disk right now** — as opposed to the version
 * of the pi process the plugin is running.
 *
 * Why this exists: the status bar's version comes from
 * `PiConnectionState.Running.installation`, a snapshot taken when the pi
 * process started. When the user upgrades pi outside the IDE (`npm install -g`),
 * that snapshot keeps pointing at the old version, so the status bar shows a
 * number that is no longer true of the machine. The diagnostics card reads the
 * disk fresh (`PiLocator.locate(forceRefresh = true)`), so the plugin ended up
 * contradicting itself (issue #6).
 *
 * The probe is cheap by construction:
 *
 * 1. **package.json first.** An npm install keeps the version in
 *    `<prefix>/node_modules/@earendil-works/pi-coding-agent/package.json`.
 *    Reading it is a file read — no subprocess, no node cold start.
 * 2. **`pi --version` as the fallback.** Non-npm layouts (script install,
 *    pnpm, a custom path) have no package.json to read, so the CLI is asked
 *    directly. That costs a node start (~1s), so it only runs when the
 *    installation actually changed.
 *
 * The [stamp] is what makes (2) affordable: it is a cheap fingerprint of the
 * installation (mtime + size of the executable and of the package.json). While
 * the stamp is unchanged the answer cannot have changed, so nothing is spawned.
 */
object PiDiskVersion {

    private val LOG = Logger.getInstance(PiDiskVersion::class.java)

    /** npm package that provides the pi CLI — the package.json to look for. */
    const val PACKAGE = "@earendil-works/pi-coding-agent"

    /**
     * How long a probed answer stays usable even if the stamp is unreadable.
     * The stamp covers the npm case; this covers everything else.
     */
    private const val TTL_MS = 60_000L

    @Volatile
    private var cachedVersion: String? = null

    @Volatile
    private var cachedStamp: String = ""

    @Volatile
    private var cachedAt: Long = 0L

    private val lock = Any()

    /**
     * The pi version currently on disk, or null when it cannot be determined.
     *
     * @param forceRefresh ignore the cache and probe again (used after the
     *   plugin itself changed the installation).
     */
    fun current(forceRefresh: Boolean = false): String? {
        val path = PiLocator.locatePath() ?: return null
        val stamp = stampOf(path)
        val now = System.currentTimeMillis()
        if (!forceRefresh && cachedVersion != null) {
            // The fingerprint covers every case where the version can change
            // without the path changing (an in-place npm upgrade).
            if (stamp.isNotEmpty() && stamp == cachedStamp) return cachedVersion
            if (stamp.isEmpty() && now - cachedAt < TTL_MS) return cachedVersion
        }
        synchronized(lock) {
            val probed = probe(path)
            cachedVersion = probed
            cachedStamp = stampOf(path)
            cachedAt = System.currentTimeMillis()
            return probed
        }
    }

    /** Drops the cached answer so the next [current] probes again. */
    fun invalidate() {
        synchronized(lock) {
            cachedVersion = null
            cachedStamp = ""
            cachedAt = 0L
        }
    }

    /**
     * Reads the version out of the installed package's package.json — no
     * subprocess. Returns null when there is no such file (non-npm install).
     */
    internal fun packageJsonVersion(piPath: String): String? {
        val pkgJson = packageJsonFor(piPath) ?: return null
        return runCatching {
            val obj = Json.parseToJsonElement(pkgJson.readText()).jsonObject
            obj["version"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() }
        }.getOrNull()
    }

    /**
     * The package.json of the npm package that provides pi, given the path of
     * the pi shim. npm keeps the shim (`<prefix>/pi.cmd`) next to the global
     * `node_modules`, so the package.json sits one level down.
     */
    internal fun packageJsonFor(piPath: String): File? {
        val shim = File(piPath)
        val prefix = shim.parentFile ?: return null
        val candidate = File(prefix, "node_modules/$PACKAGE/package.json")
        return candidate.takeIf { it.isFile }
    }

    /**
     * A cheap fingerprint of the installation: the mtime and size of the pi
     * executable and of the package.json beside it. Empty when neither can be
     * read — the caller then falls back to a time-based TTL.
     */
    internal fun stampOf(piPath: String?): String {
        if (piPath.isNullOrBlank()) return ""
        val parts = mutableListOf<String>()
        fileStamp(File(piPath))?.let { parts += it }
        packageJsonFor(piPath)?.let { fileStamp(it)?.let { p -> parts += p } }
        return parts.joinToString("|")
    }

    private fun fileStamp(f: File): String? = runCatching {
        if (!f.isFile) return null
        f.name + ":" + f.lastModified() + ":" + f.length()
    }.getOrNull()

    /**
     * The actual probe: package.json first (cheap), `pi --version` second.
     * The CLI answers the question for layouts we cannot read a file for.
     */
    private fun probe(piPath: String): String? {
        packageJsonVersion(piPath)?.let {
            LOG.debug("disk version from package.json: " + it)
            return it
        }
        val v = PiLocator.version(piPath)
        LOG.debug("disk version from pi --version: " + v)
        return v
    }
}
