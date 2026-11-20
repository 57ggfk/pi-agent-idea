package dev.pi.agent.browser

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * 052: watches Chromium's GPU child process and warns once when it keeps
 * restarting.
 *
 * The blank DevTools window of 049 was a GPU crash loop: the GPU process
 * died and was relaunched over and over, so the compositor never got a
 * command buffer and the window stayed white. The IDE's own platform code
 * only reacts after 10 launches (and then disposes the whole CEF app), so
 * this watcher reports the loop earlier and hands the user a one-click fix.
 *
 * Costs one process-tree walk every [POLL_INTERVAL_MS]; a healthy IDE has
 * exactly one GPU process, so the common case is "nothing to do".
 */
@Service(Service.Level.APP)
internal class GpuCrashMonitor private constructor() {

    private val log = Logger.getInstance(GpuCrashMonitor::class.java)
    private val tracker = GpuCrashTracker()
    private val seenGpuPids = mutableSetOf<Long>()

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
        scheduler.scheduleWithFixedDelay(
            { tick() },
            POLL_INTERVAL_MS,
            POLL_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )
        log.info("Pi Agent GPU watch started (poll every " + POLL_INTERVAL_MS + "ms)")
    }

    /**
     * One probe. A GPU process that is still alive is not a crash; only a
     * NEW GPU process id means Chromium relaunched it, which is what a crash
     * looks like from the outside.
     */
    internal fun tick(nowMs: Long = System.currentTimeMillis()) {
        val live = try {
            GpuProcessScanner.liveGpuPids()
        } catch (t: Throwable) {
            log.warn("Pi Agent GPU watch: process scan failed (" + t.javaClass.simpleName + ")")
            return
        }

        val fresh = live - seenGpuPids
        seenGpuPids.clear()
        seenGpuPids.addAll(live)
        if (fresh.isEmpty()) return

        var decision = GpuCrashDecision.NONE
        repeat(fresh.size) { decision = tracker.onGpuLaunch(nowMs) }
        log.debug("Pi Agent GPU watch: " + fresh.size + " new GPU process(es), " +
            tracker.launchesInWindow(nowMs) + " within the window")

        if (decision == GpuCrashDecision.NOTIFY && !notified) {
            notified = true
            val launches = tracker.launchesInWindow(nowMs)
            log.warn("Pi Agent: the browser GPU process restarted " + launches +
                " times in the last minute — embedded pages may stay blank")
            GpuCrashNotifier.notifyGpuCrash(launches)
        }
    }

    companion object {
        private const val POLL_INTERVAL_MS = 2_000L

        @JvmStatic
        fun getInstance(): GpuCrashMonitor = ApplicationManager.getApplication()
            .getService(GpuCrashMonitor::class.java)
    }
}
