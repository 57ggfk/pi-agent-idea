package dev.pi.agent.browser

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * 064: watches Chromium's JCEF log and warns once when the GPU process keeps
 * crashing.
 *
 * The blank DevTools window of 061 was a GPU crash loop: the GPU process died
 * and was relaunched over and over, so the compositor never got a command
 * buffer and the window stayed white. The IDE's own platform code only reacts
 * after 10 GPU launches (and then disposes the whole CEF app), so this watcher
 * reports the loop earlier and hands the user a one-click fix.
 *
 * The log is only useful when Chromium logs at ERROR level — the platform
 * defaults to "disable", which leaves the file empty. The plugin raises the
 * level itself (see [JcefLogLevelGuard]) unless the user chose one.
 *
 * Costs one small tail read every [POLL_INTERVAL_MS]; a healthy IDE writes
 * nothing to the log, so the common case is "nothing to do".
 */
@Service(Service.Level.APP)
internal class GpuCrashMonitor private constructor() {

    private val log = Logger.getInstance(GpuCrashMonitor::class.java)
    private val tracker = GpuCrashTracker()
    private val tailer = GpuCrashLogTailer(logDirectories(), ProcessHandle.current().pid())

    private val scheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "pi-agent-gpu-watch").apply { isDaemon = true }
        }

    @Volatile
    private var started = false

    @Volatile
    private var notified = false

    fun start() {
        if (started) return
        started = true
        // 064: the watch only sees anything when Chromium logs at ERROR
        // level, so the level is asked for before the first poll.
        JcefLogLevelGuard.ensure()
        scheduler.scheduleWithFixedDelay(
            { tick() },
            POLL_INTERVAL_MS,
            POLL_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )
        log.info("Pi Agent GPU watch started (poll every " + POLL_INTERVAL_MS + "ms)")
    }

    /** One poll: read what Chromium logged since the last one. */
    internal fun tick(nowMs: Long = System.currentTimeMillis()) {
        val crashes = try {
            tailer.newGpuCrashLines(nowMs)
        } catch (t: Throwable) {
            log.warn("Pi Agent GPU watch: reading the JCEF log failed (" + t.javaClass.simpleName + ")")
            return
        }
        if (crashes.isEmpty()) return

        var decision = GpuCrashDecision.NONE
        repeat(crashes.size) { decision = tracker.onGpuCrash(nowMs) }
        val total = tracker.crashesInWindow(nowMs)
        log.info("Pi Agent GPU watch: " + total + " GPU crash(es) in the last minute")

        if (decision == GpuCrashDecision.NOTIFY && !notified) {
            notified = true
            log.warn(
                "Pi Agent: the browser GPU process crashed " + total +
                    " times in the last minute — embedded pages may stay blank",
            )
            GpuCrashNotifier.notifyGpuCrash(total)
        }
    }

    companion object {
        private const val POLL_INTERVAL_MS = 2_000L

        /**
         * Where the JCEF logs may live: the IDE log directory (2026.2+),
         * the directory of a user-configured JCEF log path, and the user's
         * home (the 2024.3 default).
         */
        private fun logDirectories(): List<File> {
            val dirs = LinkedHashSet<File>()
            try {
                dirs.add(File(PathManager.getLogPath()))
            } catch (_: Throwable) {
                // No IDE log path (unit tests, headless) — nothing to watch.
            }
            try {
                System.getProperty("ide.browser.jcef.log.path")
                    ?.let { path -> File(path).parentFile?.let { dirs.add(it) } }
            } catch (_: Throwable) {
                // No custom JCEF log path.
            }
            try {
                System.getProperty("user.home")?.let { dirs.add(File(it)) }
            } catch (_: Throwable) {
                // No home directory.
            }
            return dirs.toList()
        }

        @JvmStatic
        fun getInstance(): GpuCrashMonitor = ApplicationManager.getApplication()
            .getService(GpuCrashMonitor::class.java)
    }
}
