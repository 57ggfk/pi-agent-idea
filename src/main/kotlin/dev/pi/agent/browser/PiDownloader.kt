package dev.pi.agent.browser

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import com.intellij.ide.BrowserUtil
import dev.pi.agent.PiAgentBundle
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * IDE-side file downloads that bypass CEF entirely (F-213 layer 1).
 *
 * Why this exists: under IDEA 2025.2+ the platform runs CEF out-of-process
 * (cef_server), and that RPC channel has no DownloadHandler callbacks at all
 * (F-213: the thrift AsyncClient method list contains no DownloadHandler_*),
 * so the 048 download handler never fires there. Anything the frontend can
 * name as a local path (chat artifact files, preview files) downloads through
 * here — plain JDK filesystem copy into the user's Downloads dir — which
 * works identically on every IDE build.
 *
 * The notification carries a "reveal" action that opens the target folder
 * (the F-213 体验点: a done-notification whose click lands in the directory),
 * shared with the kernel's CEF-download notification so both paths behave the
 * same.
 */
object PiDownloader {

    /** Largest artifact accepted; guards against accidental whole-repo copies. */
    private const val MAX_COPY_BYTES = 512L * 1024 * 1024

    private const val NOTIFICATION_GROUP = "Pi Agent"

    /**
     * Copies the local file [source] into the user's Downloads directory
     * (never overwriting an existing file) and notifies. Returns the target
     * path, or null with a failure notification when the source is unusable.
     */
    fun downloadFile(project: Project?, source: Path?): Path? {
        if (source == null) {
            notifyFailure(project, "no file path given")
            return null
        }
        val file: Path = try {
            source.toAbsolutePath().normalize()
        } catch (e: Exception) {
            notifyFailure(project, LogSafe.truncate(e.message ?: e.javaClass.simpleName))
            return null
        }
        if (!Files.isRegularFile(file)) {
            notifyFailure(project, "not a readable file: ${file.fileName}")
            return null
        }
        val size = runCatching { Files.size(file) }.getOrNull()
        if (size == null || size > MAX_COPY_BYTES) {
            notifyFailure(project, "file not readable or too large to save")
            return null
        }
        val target = uniqueTarget(downloadsDir(), UrlNormalizer.downloadFileName(file.fileName.toString()))
        val copied = runCatching {
            Files.copy(file, target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }.getOrNull()
        if (copied == null) {
            notifyFailure(project, "copy to Downloads failed")
            return null
        }
        notifyDone(project, target.absolutePath)
        return target.toPath()
    }

    private fun downloadsDir(): File {
        val dir = File(System.getProperty("user.home"), "Downloads")
        dir.mkdirs()
        return dir
    }

    private fun uniqueTarget(dir: File, name: String): File {
        var candidate = File(dir, name)
        if (!candidate.exists()) return candidate
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var n = 1
        while (candidate.exists()) {
            candidate = File(dir, "$base ($n)$ext")
            n++
        }
        return candidate
    }

    /** The shared "open the folder" action for download notifications. */
    fun revealAction(path: String): AnAction = object : AnAction(PiAgentBundle.message("browser.download.reveal")) {
        override fun actionPerformed(e: AnActionEvent) {
            val f = File(path)
            if (f.exists()) BrowserUtil.browse(if (f.isDirectory) f else f.parentFile)
        }
    }

    fun notifyDone(project: Project?, path: String) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup(NOTIFICATION_GROUP)
            .createNotification(
                PiAgentBundle.message("browser.download.done", LogSafe.truncate(path, 120)),
                NotificationType.INFORMATION,
            )
            .addAction(revealAction(path))
            .notify(project)
    }

    fun notifyFailure(project: Project?, reason: String) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup(NOTIFICATION_GROUP)
            .createNotification(
                PiAgentBundle.message("browser.download.failed", LogSafe.truncate(reason, 120)),
                NotificationType.ERROR,
            )
            .notify(project)
    }
}
