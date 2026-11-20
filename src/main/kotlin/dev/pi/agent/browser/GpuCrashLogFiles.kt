package dev.pi.agent.browser

import java.io.File

/**
 * 052: finds the JCEF/Chromium log files of THIS IDE run.
 *
 * The platform names them `jcef_<pid>.log` (the JCEF bridge log) and
 * `jcef_chromium_<pid>.log` (Chromium's native log, where the GPU crash
 * lines live). The directory differs by version — 2026.2 puts them in the IDE
 * log directory, 2024.3 defaults to the user's home — so several directories
 * are searched and the files are matched by pid (or by "touched recently",
 * for platforms that name them differently).
 */
internal object GpuCrashLogFiles {

    const val FILE_PREFIX = "jcef"
    const val FILE_SUFFIX = ".log"

    /** A log file worth watching, with its last modification time. */
    data class Candidate(val name: String, val lastModifiedMs: Long, val path: String = name)

    /** A file not touched for this long belongs to an older IDE run. */
    const val RECENT_WINDOW_MS = 5 * 60_000L

    /**
     * The files worth watching: JCEF logs of this run. Old runs' logs are
     * left alone — their crashes are history, not the current problem.
     */
    fun select(candidates: List<Candidate>, pid: Long, nowMs: Long): List<Candidate> =
        candidates.filter { candidate ->
            candidate.name.startsWith(FILE_PREFIX) &&
                candidate.name.endsWith(FILE_SUFFIX) &&
                (
                    candidate.name.contains(pid.toString()) ||
                        nowMs - candidate.lastModifiedMs <= RECENT_WINDOW_MS
                    )
        }

    /** The same selection over the files actually on disk. */
    fun discover(dirs: List<File>, pid: Long, nowMs: Long): List<Candidate> {
        val found = ArrayList<Candidate>()
        for (dir in dirs) {
            val files = try {
                dir.listFiles { file: File ->
                    file.isFile && file.name.startsWith(FILE_PREFIX) && file.name.endsWith(FILE_SUFFIX)
                }
            } catch (_: Throwable) {
                null
            }
            files?.forEach { found.add(Candidate(it.name, it.lastModified(), it.absolutePath)) }
        }
        return select(found, pid, nowMs)
    }
}
