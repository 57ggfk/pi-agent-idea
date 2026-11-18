package dev.pi.agent.browser

import java.nio.file.Files
import java.nio.file.Path
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * One-shot local-HTML preview registry (spec 048 T015 / plan D10).
 *
 * Local HTML never loads through `file://` (hard constraint 2): callers copy
 * the file into this object's temp root and get a 128-bit random token; the
 * UI server serves `/preview/<token>` exactly once within [TTL_MS], then the
 * token is dead. Entries beyond the TTL are garbage collected lazily.
 *
 * Security posture: the token is unguessable, single-use, short-lived, and
 * the served path must live inside the temp root — a token can therefore
 * never be used to read arbitrary local files.
 */
object PiBrowserPreviews {

    private const val TOKEN_BYTES = 16
    const val TTL_MS: Long = 5 * 60 * 1000

    private val random = SecureRandom()
    private val entries = ConcurrentHashMap<String, Entry>()

    /** Lazily created root; every served file must live inside it. */
    @Volatile
    private var root: Path? = null

    private data class Entry(val path: Path, val createdAt: Long)

    /** The whitelisted directory preview copies live in. */
    fun previewRoot(): Path {
        root?.let { return it }
        synchronized(this) {
            root?.let { return it }
            val dir = Files.createTempDirectory("pi-agent-preview")
            root = dir
            return dir
        }
    }

    /**
     * Registers [file] for exactly one fetch. The file MUST already live in
     * [previewRoot] (callers copy first); anything else is refused — the
     * route must never become a reader for arbitrary local paths.
     */
    fun register(file: Path): String {
        val canonical = file.toAbsolutePath().normalize()
        require(canonical.startsWith(previewRoot())) { "preview files must live in the preview root" }
        clearExpired()
        val token = newToken()
        entries[token] = Entry(canonical, System.currentTimeMillis())
        return token
    }

    /**
     * Single use: returns the file path once, then the token is dead. Expired
     * or unknown tokens return null. The returned file is deleted after a
     * successful serve so the temp root does not grow unbounded.
     */
    fun take(token: String): Path? {
        val entry = entries.remove(token) ?: return null
        if (System.currentTimeMillis() - entry.createdAt > TTL_MS) return null
        return entry.path.takeIf { Files.exists(it) }
    }

    private fun clearExpired() {
        val now = System.currentTimeMillis()
        entries.entries.removeIf { now - it.value.createdAt > TTL_MS }
    }

    private fun newToken(): String {
        val bytes = ByteArray(TOKEN_BYTES)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
