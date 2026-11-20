package dev.pi.agent.browser

/**
 * 052: when does a JCEF GPU crash loop deserve a user-facing warning?
 *
 * Why the plugin counts processes instead of listening for an event: the
 * platform hook this would normally use does not exist on the supported line.
 * `JBCefHealthMonitor` / `JBCefHealthCheckTopic` are absent from 233-263
 * (checked against the 2024.3.1 sources jar and the 262 runtime jars), and
 * the one hook that DOES exist — `CefAppHandler.onBeforeChildProcessLaunch` —
 * can only be registered BEFORE the CEF app is initialized (`CefApp
 * .addAppHandler` throws "Must be called before CefApp is initialized") into
 * a single static slot that the platform already owns (`JBCefApp
 * .MyCefAppHandler` counts `--type=gpu-process` launches itself and shows
 * its own notification at 10 launches).
 *
 * Chromium relaunches a crashed GPU process as a NEW process, and every
 * launch carries `--type=gpu-process` in its command line. Counting distinct
 * GPU processes over a window is therefore a direct read of "the GPU keeps
 * crashing" — with no platform dependency at all.
 */
internal object GpuCrashPolicy {

    /** Chromium's marker for the GPU child process. */
    const val GPU_PROCESS_MARKER = "--type=gpu-process"

    /** How far back a launch still counts as "recent". */
    const val WINDOW_MS = 60_000L

    /**
     * How many GPU launches inside the window mean "crash loop".
     *
     * A healthy IDE starts exactly one GPU process per CEF app, so three
     * launches inside a minute is already abnormal — and it stays well below
     * the platform's own limit of 10, so the user hears about it before the
     * IDE tears down its whole browser stack.
     */
    const val MIN_LAUNCHES = 3

    fun isGpuProcess(commandLine: String?): Boolean =
        commandLine != null && commandLine.contains(GPU_PROCESS_MARKER)

    fun launchesInWindow(
        launchTimestampsMs: List<Long>,
        nowMs: Long,
        windowMs: Long = WINDOW_MS,
    ): Int = launchTimestampsMs.count { nowMs - it in 0..windowMs }

    fun decide(
        launchTimestampsMs: List<Long>,
        nowMs: Long,
        minLaunches: Int = MIN_LAUNCHES,
    ): GpuCrashDecision =
        if (launchesInWindow(launchTimestampsMs, nowMs) >= minLaunches) {
            GpuCrashDecision.NOTIFY
        } else {
            GpuCrashDecision.NONE
        }
}

/** What the detector decided about the GPU launches it has seen. */
internal enum class GpuCrashDecision { NONE, NOTIFY }

/**
 * Sliding-window state of GPU launches. Pure on purpose: no clock, no
 * processes — the caller feeds it timestamps, so the policy stays unit
 * testable.
 */
internal class GpuCrashTracker(
    private val windowMs: Long = GpuCrashPolicy.WINDOW_MS,
    private val minLaunches: Int = GpuCrashPolicy.MIN_LAUNCHES,
) {
    private val launches = ArrayDeque<Long>()

    @Synchronized
    fun onGpuLaunch(nowMs: Long): GpuCrashDecision {
        launches.addLast(nowMs)
        return decision(nowMs)
    }

    @Synchronized
    fun decision(nowMs: Long): GpuCrashDecision {
        prune(nowMs)
        return GpuCrashPolicy.decide(launches.toList(), nowMs, minLaunches)
    }

    @Synchronized
    fun launchesInWindow(nowMs: Long): Int {
        prune(nowMs)
        return launches.size
    }

    private fun prune(nowMs: Long) {
        while (launches.isNotEmpty() && nowMs - launches.first() > windowMs) {
            launches.removeFirst()
        }
    }
}
