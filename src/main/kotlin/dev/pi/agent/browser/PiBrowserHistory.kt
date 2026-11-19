package dev.pi.agent.browser

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project

/**
 * The browser tab's recently-visited URLs (F-201). In-memory per project —
 * survives tab close/reopen within the session (the main pain point: "closed
 * the tab, had to remember the dev-server port"), deliberately NOT
 * persistent across IDE restarts (048 hard rule 8 posture: no browsing
 * history on disk until there is a privacy decision for it).
 *
 * LRU with dedup: revisiting an entry moves it to the front. Nothing here is
 * ever logged; entries are only handed to the address bar's dropdown.
 */
@Service(Service.Level.PROJECT)
class PiBrowserHistory {

    private val lock = Any()
    private val entries = ArrayDeque<String>()

    /** Adds [url] (raw) as the most recent entry, deduplicated, LRU-bounded. */
    fun add(url: String) {
        val trimmed = url.trim()
        if (trimmed.isEmpty()) return
        synchronized(lock) {
            entries.remove(trimmed)
            entries.addFirst(trimmed)
            while (entries.size > MAX_ENTRIES) entries.removeLast()
        }
    }

    /** Snapshot for the address bar dropdown, most recent first. */
    fun entries(): List<String> = synchronized(lock) { entries.toList() }

    fun clear() = synchronized(lock) { entries.clear() }

    companion object {
        private const val MAX_ENTRIES = 20

        /** Public so the address field's editor history size matches. */
        const val MAX_HISTORY = 20

        @JvmStatic
        fun getInstance(project: Project): PiBrowserHistory =
            project.getService(PiBrowserHistory::class.java)
    }
}
