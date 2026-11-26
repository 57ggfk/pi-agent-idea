package dev.pi.agent.browser

/**
 * 064: when does a JCEF GPU crash loop deserve a user-facing warning?
 *
 * Why the plugin reads Chromium's own log instead of listening for an event:
 * both platform hooks are checked and neither can warn early.
 *
 * - `JBCefHealthMonitor` / `JBCefHealthCheckTopic` exist in 2026.2 only
 *   (absent from 233-243), and the platform calls `onGpuProcessFailed()`
 *   only after ITS OWN gpu-launch limit is exceeded — 10 launches by
 *   default, by which time it has already disposed the whole CEF app.
 *   Late is not early.
 * - `CefApp.addAppHandler` throws unless no CefApp instance exists yet, and
 *   the single user slot REPLACES the platform's handler (the CefApp
 *   constructor assigns `appHandler_ = userAppHandler_`). Taking it would
 *   silently disable the platform's own gpu-launch counting.
 *
 * The platform's JCEF writes Chromium's native log next to the IDE log, and
 * every GPU crash lands there as
 * `ERROR:content\browser\gpu\gpu_process_host.cc] GPU process exited
 * unexpectedly: exit_code=…` — verified on 2026.2.3: three kills of the GPU
 * process produced exactly three such lines, and the 061 crash session left
 * 385 of them. Counting those lines inside a window is a direct read of "the
 * GPU keeps crashing".
 *
 * The log only carries those lines when Chromium logs at ERROR level — the
 * platform defaults to "disable", which leaves the file empty. The plugin
 * raises the level itself (see [JcefLogLevelPolicy]) before the first
 * browser is created.
 *
 * Counting PROCESSES instead was tried first and does not work on Windows:
 * `ProcessHandle.Info.commandLine()` returns null there (verified on
 * 2026.2.3 — even for the JVM's own child), so a GPU process cannot be told
 * apart from the renderer and utility children.
 */
internal object GpuCrashPolicy {

    /** Chromium's wording for a GPU process that died. Exactly one per crash. */
    const val GPU_CRASH_MARKER = "GPU process exited unexpectedly"

    /** How far back a crash still counts as "recent". */
    const val WINDOW_MS = 60_000L

    /**
     * How many GPU crashes inside the window mean "crash loop".
     *
     * The platform's own limit is 10 GPU process launches, after which it
     * disposes the whole CEF app. Three crashes inside a minute is already
     * abnormal and fires well before that, so the user hears about it while
     * the IDE still works.
     */
    const val MIN_CRASHES = 3

    fun isGpuCrashLine(line: String): Boolean = line.contains(GPU_CRASH_MARKER)

    fun countGpuCrashLines(lines: List<String>): Int = lines.count { isGpuCrashLine(it) }

    fun crashesInWindow(
        crashTimestampsMs: List<Long>,
        nowMs: Long,
        windowMs: Long = WINDOW_MS,
    ): Int = crashTimestampsMs.count { nowMs - it in 0..windowMs }

    fun decide(
        crashTimestampsMs: List<Long>,
        nowMs: Long,
        minCrashes: Int = MIN_CRASHES,
    ): GpuCrashDecision =
        if (crashesInWindow(crashTimestampsMs, nowMs) >= minCrashes) {
            GpuCrashDecision.NOTIFY
        } else {
            GpuCrashDecision.NONE
        }
}

/** What the detector decided about the GPU crashes it has seen. */
internal enum class GpuCrashDecision { NONE, NOTIFY }

/**
 * Sliding-window state of GPU crashes. Pure on purpose: no clock, no files —
 * the caller feeds it timestamps, so the policy stays unit testable.
 */
internal class GpuCrashTracker(
    private val windowMs: Long = GpuCrashPolicy.WINDOW_MS,
    private val minCrashes: Int = GpuCrashPolicy.MIN_CRASHES,
) {
    private val crashes = ArrayDeque<Long>()

    @Synchronized
    fun onGpuCrash(nowMs: Long): GpuCrashDecision {
        crashes.addLast(nowMs)
        return decision(nowMs)
    }

    @Synchronized
    fun decision(nowMs: Long): GpuCrashDecision {
        prune(nowMs)
        return GpuCrashPolicy.decide(crashes.toList(), nowMs, minCrashes)
    }

    @Synchronized
    fun crashesInWindow(nowMs: Long): Int {
        prune(nowMs)
        return crashes.size
    }

    private fun prune(nowMs: Long) {
        while (crashes.isNotEmpty() && nowMs - crashes.first() > windowMs) {
            crashes.removeFirst()
        }
    }
}
