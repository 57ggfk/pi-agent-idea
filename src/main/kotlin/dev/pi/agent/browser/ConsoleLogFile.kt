package dev.pi.agent.browser

import com.intellij.openapi.application.PathManager
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.nio.charset.StandardCharsets

/**
 * 053 B3: append-only JSONL capture of the browser tab's console lines —
 * the agent's grep channel for history beyond the in-memory window
 * ([BrowserConsoleBuffer]). Cursor-style "console 落盘可 grep".
 *
 * Privacy boundary (spec 053, the F-201 口径): the file lives ONLY in the
 * IDE system dir (`<system>/pi-agent/browser-console/`), machine-local and
 * never synced or exported; it stores ONLY lines that already passed
 * [LogSafe.truncate] (severity-filtered error/warning, ≤200 chars, one
 * line); console lines may carry page URLs, so the file is user-private
 * material — it is never written to idea.log and never attached anywhere
 * (048 hard rule 8). Rotation keeps disk usage bounded no matter how chatty
 * the page is. All IO is best-effort: a full or locked disk must never
 * break the browser tab or the console capture.
 */
class ConsoleLogFile(
    private val dir: File,
    private val baseName: String = "console",
    /** Rotate the primary file once it reaches this size. */
    private val maxFileBytes: Long = 1_000_000L,
    /** Number of numbered siblings (console.1..N.jsonl) to keep. */
    private val keepRotated: Int = 3,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {

    private val lock = Any()
    private var seq = 0

    /** Absolute path of the primary (current) file, as returned in tool responses. */
    val path: String get() = File(dir, "$baseName.jsonl").absolutePath

    /**
     * Appends one JSON object per line: `{"ts":…,"seq":…,"index":…,"text":…}`.
     * [index] is the buffer's monotonic line index (page-scoped), [seq] the
     * file-wide counter; [text] must already be LogSafe.truncate'd by the
     * caller — this class never widens what was captured.
     */
    fun append(index: Int, text: String) {
        if (text.isBlank()) return
        val line: String
        synchronized(lock) {
            seq += 1
            line = """{"ts":${nowMs()},"seq":$seq,"index":$index,"text":${JsonPrimitive(text)}}"""
            try {
                if (!dir.isDirectory && !dir.mkdirs()) return
                val primary = File(dir, "$baseName.jsonl")
                if (primary.isFile && primary.length() >= maxFileBytes) rotate()
                primary.appendText(line + "\n", StandardCharsets.UTF_8)
            } catch (_: Exception) {
                // Best-effort by design (048 hard rule 8): disk problems are
                // silently ignored — the in-memory buffer stays authoritative.
            }
        }
    }

    /** console.N ← console.N-1 …; console.1 ← console; the primary starts empty. */
    private fun rotate() {
        for (i in keepRotated downTo 1) {
            val target = File(dir, "$baseName.$i.jsonl")
            val source = if (i == 1) File(dir, "$baseName.jsonl") else File(dir, "$baseName.${i - 1}.jsonl")
            try {
                target.delete()
                if (source.isFile) source.renameTo(target)
            } catch (_: Exception) {
                // Rotation failure must not break the append below.
            }
        }
    }

    companion object {

        /**
         * The run-wide capture dir under the IDE system path. Returns null
         * outside an IDE (unit tests, headless) — nothing to write to.
         */
        fun defaultDir(): File? = try {
            File(PathManager.getSystemPath(), "pi-agent/browser-console")
        } catch (_: Throwable) {
            null
        }

        /** The shared per-IDE-run capture file; null when there is no system dir. */
        fun default(): ConsoleLogFile? = defaultDir()?.let { ConsoleLogFile(it) }
    }
}
