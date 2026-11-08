package dev.pi.agent.bridge

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import dev.pi.agent.PiAgentBundle
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.jetbrains.plugins.terminal.ShellTerminalWidget
import org.jetbrains.plugins.terminal.TerminalView
import java.awt.datatransfer.StringSelection

/**
 * `ide.openTerminal` (013 US2): the OAuth "account" login cannot run inside
 * the panel yet, so the UI hands the flow to a real terminal that launches pi.
 *
 * Two paths, reported honestly to the UI:
 *  1. typed    — a fresh local shell tab is created and [command] executed in
 *                it (`TerminalView.createLocalShellWidget` + `executeCommand`;
 *                javap-verified present on both the 2024.3.1 build target and
 *                the 2026.2 runtime);
 *  2. fallback — any failure (terminal plugin disabled, session creation
 *                failed, …) degrades to activating the Terminal tool window,
 *                copying the command to the clipboard and raising a balloon;
 *                the response carries `typed=false` so the UI can say
 *                "paste it yourself" instead of pretending.
 *
 * The command comes from the frontend but is sanitized here regardless
 * (one shell line, bounded length) — a bridge caller never types free text
 * into a shell.
 */
object PiIdeTerminal {

    private val LOG = Logger.getInstance(PiIdeTerminal::class.java)

    /** Tab name shown in the terminal tool window. */
    private const val TAB_NAME = "Pi Agent"

    private const val MAX_COMMAND_LENGTH = 200

    /** One shell line, bounded: CR/LF collapsed, blank or oversized rejected. */
    fun sanitizeCommand(raw: String?): String? {
        val cleaned = raw?.replace(Regex("[\r\n]+"), " ")?.trim().orEmpty()
        return if (cleaned.isNotEmpty() && cleaned.length <= MAX_COMMAND_LENGTH) cleaned else null
    }

    fun open(project: Project, rawCommand: String): JsonObject {
        val command = sanitizeCommand(rawCommand)
            ?: return outcome(ok = false, typed = false, error = "invalid command")
        var typed = false
        var primaryError: Throwable? = null
        ApplicationManager.getApplication().invokeAndWait {
            try {
                val terminal = TerminalView.getInstance(project)
                val widget = terminal.createLocalShellWidget(project.basePath, TAB_NAME)
                    ?: throw IllegalStateException("terminal session could not be created")
                widget.executeCommand(command)
                typed = true
            } catch (e: Throwable) {
                // Throwable on purpose: a disabled Terminal plugin surfaces as
                // NoClassDefFoundError (the optional depends did not link), not
                // as an Exception.
                primaryError = e
            }
        }
        if (typed) return outcome(ok = true, typed = true, error = null)

        LOG.info("ide.openTerminal: typed path failed (${primaryError?.message}); using copy fallback")
        val fallback = activateTerminalAndCopy(project, command)
        return if (fallback == null) {
            outcome(ok = true, typed = false, error = null)
        } else {
            LOG.warn("ide.openTerminal: fallback also failed", fallback)
            outcome(ok = false, typed = false, error = fallback.message ?: "terminal unavailable")
        }
    }

    /** Degrade gracefully: Terminal tool window up, command on the clipboard,
     *  balloon explaining what to do. Returns the failure, or null on success. */
    private fun activateTerminalAndCopy(project: Project, command: String): Throwable? {
        return try {
            ApplicationManager.getApplication().invokeAndWait {
                CopyPasteManager.getInstance().setContents(StringSelection(command))
                try {
                    com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
                        .getToolWindow("Terminal")
                        ?.activate(null)
                } catch (e: Exception) {
                    LOG.warn("ide.openTerminal: cannot activate Terminal tool window", e)
                }
                NotificationGroupManager.getInstance()
                    .getNotificationGroup("Pi Agent")
                    .createNotification(
                        PiAgentBundle.message("terminal.fallback.title"),
                        PiAgentBundle.message("terminal.fallback.body", command),
                        NotificationType.INFORMATION,
                    )
                    .notify(project)
            }
            null
        } catch (e: Throwable) {
            e
        }
    }

    /** The response envelope the frontend keys on (`typed` separates the two
     *  honest paths). Internal so the unit suite can pin the shape without an
     *  IDE — the dispatch contract depends on it. */
    internal fun outcome(ok: Boolean, typed: Boolean, error: String?): JsonObject = buildJsonObject {
        put("ok", ok)
        put("typed", typed)
        error?.let { put("error", it) }
    }
}
