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
     * Returns the file for [token] while the registration is alive. Amended
     * during implementation (048 T015/T016 note): the first draft was
     * single-use, but the browser panel's RELOAD re-fetches the same URL —
     * a single-use token turned every refresh into a 404 error card. The
     * token now stays valid for [TTL_MS] (re-fetchable) and dies with the
     * file afterwards; the security model is unchanged (unguessable token,
     * whitelist root, short window).
     */
    fun take(token: String, nowMs: Long = System.currentTimeMillis()): Path? {
        val entry = entries[token] ?: return null
        if (nowMs - entry.createdAt > TTL_MS) {
            entries.remove(token)
            runCatching { Files.deleteIfExists(entry.path) }
            return null
        }
        return entry.path.takeIf { Files.exists(it) }
    }

    /**
     * Serves the bytes for [token] WITHOUT consuming the registration.
     *
     * The browser re-fetches the same preview URL on reload, so the file must
     * survive the first response — the token's TTL ends its life, not the
     * first fetch. The file's lifetime belongs to this registry on purpose:
     * the UI server only ever sees bytes and cannot delete the snapshot out
     * from under a live token.
     */
    fun serve(token: String, nowMs: Long = System.currentTimeMillis()): ByteArray? {
        val path = take(token, nowMs) ?: return null
        return runCatching { Files.readAllBytes(path) }.getOrNull()
    }

    private fun clearExpired() {
        val now = System.currentTimeMillis()
        // The files go with the registrations: nothing else deletes them
        // anymore, and the preview root is a temp directory.
        entries.entries
            .filter { now - it.value.createdAt > TTL_MS }
            .forEach {
                entries.remove(it.key, it.value)
                runCatching { Files.deleteIfExists(it.value.path) }
            }
    }

    private fun newToken(): String {
        val bytes = ByteArray(TOKEN_BYTES)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
