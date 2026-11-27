package dev.pi.agent.process

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.util.Alarm
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Watches the pi version **on disk** and reports it when it changes.
 *
 * The status bar shows two facts: the version of the pi process the plugin is
 * running, and the version installed on the machine. They are equal until the
 * user upgrades pi outside the IDE — then the disk moves and the running
 * process does not, and the status bar has to say so (issue #6).
 *
 * The watch is cheap: [PiDiskVersion] fingerprints the installation and only
 * probes when that fingerprint changed, so the common tick costs one stat.
 *
 * A project-level service because the version is per-machine but the reporting
 * is per window: two IDE windows on the same machine must not fight over the
 * probe cache.
 */
@Service(Service.Level.PROJECT)
class PiDiskVersionWatcher(private val project: Project) : Disposable {

    private val LOG = Logger.getInstance(PiDiskVersionWatcher::class.java)

    private val listeners = CopyOnWriteArrayList<(String?) -> Unit>()

    private val alarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)

    @Volatile
    private var lastReported: String? = null

    @Volatile
    private var started = false

    /** How often the installation is checked for changes. */
    private val periodMs = TimeUnit.SECONDS.toMillis(POLL_SECONDS)

    /**
     * Starts the watch and reports the current disk version right away.
     * Idempotent: calling it twice does not double the polling.
     */
    fun start() {
        if (started) return
        started = true
        reportNow()
        alarm.addRequest({ tick() }, periodMs)
    }

    /** Subscribes to disk-version changes; the listener fires immediately. */
    fun addListener(listener: (String?) -> Unit) {
        listeners.add(listener)
        listener(lastReported)
    }

    fun removeListener(listener: (String?) -> Unit) {
        listeners.remove(listener)
    }

    /** Re-probes now and reports if the answer changed. */
    fun reportNow(force: Boolean = false) {
        val version = runCatching { PiDiskVersion.current(forceRefresh = force) }
            .onFailure { LOG.debug("disk version probe failed: " + it.message) }
            .getOrNull()
        if (version == lastReported && !force) return
        lastReported = version
        listeners.forEach { listener ->
            runCatching { listener(version) }.onFailure { LOG.warn("disk version listener failed", it) }
        }
    }

    private fun tick() {
        reportNow()
        alarm.addRequest({ tick() }, periodMs)
    }

    override fun dispose() {
        listeners.clear()
    }

    companion object {
        /** Seconds between two checks of the installation. */
        const val POLL_SECONDS = 30L
    }
}
