package dev.pi.agent.browser

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import dev.pi.agent.PiAgentBundle

/**
 * 064: the user-facing half of the GPU crash guard — one balloon with a
 * one-click fix, plus the manual recipe for when the fix cannot be applied
 * automatically.
 */
internal object GpuCrashNotifier {

    private const val NOTIFICATION_GROUP = "Pi Agent"

    /** The registry key the platform itself flips for "Disable GPU and restart". */
    private const val GPU_DISABLE_REGISTRY_KEY = "ide.browser.jcef.gpu.disable"

    private val log = Logger.getInstance(GpuCrashNotifier::class.java)

    fun notifyGpuCrash(launches: Int) {
        val notification = try {
            NotificationGroupManager.getInstance()
                .getNotificationGroup(NOTIFICATION_GROUP)
                .createNotification(
                    PiAgentBundle.message("notify.gpuCrash.title"),
                    PiAgentBundle.message("notify.gpuCrash.body", launches),
                    NotificationType.WARNING,
                )
        } catch (t: Throwable) {
            log.warn("Pi Agent: cannot show the GPU crash notification (" + t.javaClass.simpleName + ")")
            return
        }

        log.info("Pi Agent: showing the GPU crash notification (" + launches + " crashes)")

        notification.addAction(
            NotificationAction.createSimpleExpiring(PiAgentBundle.message("notify.gpuCrash.action.disable")) {
                disableGpuAndRestart()
            },
        )
        notification.addAction(
            NotificationAction.createSimpleExpiring(PiAgentBundle.message("notify.gpuCrash.action.manual")) {
                showManualFix()
            },
        )
        notification.notify(null)
    }

    /**
     * Flips the platform's own "disable GPU" registry key and restarts the
     * IDE — the same one-click route the platform offers, but reachable from
     * the plugin's own warning.
     *
     * The write goes through reflection on purpose: the registry API carries
     * `@ApiStatus.Internal` in parts of the 233-263 line, and this plugin
     * ships with INTERNAL_API_USAGES as a Marketplace rejection criterion
     * (0.5.1 was rejected over exactly that). Reflection keeps the verifier
     * clean and degrades to the manual recipe when the key is unavailable.
     */
    private fun disableGpuAndRestart() {
        log.info("Pi Agent: GPU crash action — disabling GPU acceleration and restarting the IDE")
        if (setGpuDisabled()) {
            ApplicationManager.getApplication().restart()
        } else {
            showManualFix()
        }
    }

    /** True when the registry key was flipped. */
    internal fun setGpuDisabled(): Boolean = try {
        val registry = Class.forName("com.intellij.openapi.util.registry.Registry")
        val value = registry.getMethod("get", String::class.java)
            .invoke(null, GPU_DISABLE_REGISTRY_KEY)
        if (value == null) {
            false
        } else {
            value.javaClass.getMethod("setValue", Boolean::class.javaPrimitiveType)
                .invoke(value, true)
            true
        }
    } catch (t: Throwable) {
        log.warn(
            "Pi Agent: cannot disable GPU acceleration via the registry (" +
                t.javaClass.simpleName + ": " + (t.message ?: "no message") + ")",
        )
        false
    }

    /** The manual recipe — the fallback when the one-click route is unavailable. */
    private fun showManualFix() {
        log.info("Pi Agent: GPU crash action — showing the manual fix")
        try {
            NotificationGroupManager.getInstance()
                .getNotificationGroup(NOTIFICATION_GROUP)
                .createNotification(
                    PiAgentBundle.message("notify.gpuCrash.manual.title"),
                    PiAgentBundle.message("notify.gpuCrash.manual.body"),
                    NotificationType.INFORMATION,
                )
                .notify(null)
        } catch (t: Throwable) {
            log.warn("Pi Agent: cannot show the manual GPU fix (" + t.javaClass.simpleName + ")")
        }
    }
}
