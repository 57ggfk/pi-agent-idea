package dev.pi.agent.vcs

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.diff.impl.patch.IdeaTextPatchBuilder
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.CheckinProjectPanel
import com.intellij.openapi.vcs.CommitMessageI
import com.intellij.openapi.vcs.VcsDataKeys
import com.intellij.openapi.vcs.changes.Change
import com.intellij.openapi.vcs.ui.Refreshable
import dev.pi.agent.manage.PiCliRunner

/**
 * "Generate Commit Message with pi": builds the unified diff of the changes
 * included in the commit panel, asks a headless one-shot pi (`--print`) to
 * write a Conventional Commits message, and fills it into the commit message
 * field. Runs outside the chat session (`--no-session --no-tools ...`) so the
 * conversation and the agent context stay untouched.
 */
class PiGenerateCommitMessageAction : AnAction() {

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && includedChanges(e).isNotEmpty()
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val changes = includedChanges(e)
        if (changes.isEmpty()) return
        val target = messageTarget(e) ?: return

        object : Task.Backgroundable(project, TITLE, true) {
            override fun run(indicator: ProgressIndicator) {
                generate(project, changes, indicator).fold(
                    onSuccess = { text ->
                        // CommitMessageI implementations require the EDT.
                        ApplicationManager.getApplication().invokeLater {
                            target.setCommitMessage(text)
                        }
                        notify(project, "Commit message generated", NotificationType.INFORMATION)
                    },
                    onFailure = { error ->
                        LOG.warn("commit message generation failed", error)
                        notify(
                            project,
                            "Failed to generate commit message: ${error.message}",
                            NotificationType.ERROR,
                        )
                    },
                )
            }

            override fun onCancel() {
                notify(project, "Commit message generation cancelled", NotificationType.WARNING)
            }
        }.queue()
    }

    /** Diff → prompt → headless pi → cleaned commit message. */
    private fun generate(project: Project, changes: List<Change>, indicator: ProgressIndicator): Result<String> {
        indicator.text = "Building diff…"
        val diff = try {
            val basePath = project.basePath ?: ""
            val patches = IdeaTextPatchBuilder.buildPatch(project, changes, basePath, false)
            CommitMessageBuilder.unifiedDiff(patches)
        } catch (e: Exception) {
            return Result.failure(IllegalStateException("could not build diff: ${e.message}", e))
        }
        if (diff.isBlank()) {
            return Result.failure(IllegalStateException("the included changes have no textual diff"))
        }

        indicator.text = "Asking pi to write the commit message…"
        val result = PiCliRunner.run(
            args = listOf(
                "--print", "--no-session", "--no-tools", "--no-mcp",
                "-ne", "-ns", "-np", "-nc",
            ),
            timeoutSeconds = TIMEOUT_SECONDS,
            stdinText = CommitMessageBuilder.buildPrompt(diff, project.name),
        )
        if (indicator.isCanceled) return Result.failure(InterruptedException("cancelled"))

        if (!result.success) {
            val detail = (result.stderr.ifBlank { result.stdout }).trim()
            return Result.failure(IllegalStateException(detail.ifBlank { "pi exited with code ${result.exitCode}" }))
        }
        val message = CommitMessageBuilder.cleanReply(result.stdout)
        if (message.isBlank()) {
            return Result.failure(IllegalStateException("pi returned an empty message"))
        }
        return Result.success(message)
    }

    private fun notify(project: Project, body: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("Pi Agent")
            .createNotification(title = "Pi Agent", content = body, type = type)
            .notify(project)
    }

    private fun messageTarget(e: AnActionEvent): CommitMessageI? =
        e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL)
            ?: e.getData(Refreshable.PANEL_KEY) as? CommitMessageI

    /**
     * Included (checked) changes. The non-modal commit panel exposes them on
     * its concrete class (the platform classes are Kotlin-compiled, so the
     * getters are called as functions); the modal commit dialog answers the
     * classic SELECTED_CHANGES/CHANGES data keys.
     */
    private fun includedChanges(e: AnActionEvent): List<Change> {
        val panel = e.getData(Refreshable.PANEL_KEY)
        if (panel != null) {
            val asCommitPanel = panel as? com.intellij.vcs.commit.ChangesViewCommitPanel
            if (asCommitPanel != null) return asCommitPanel.getIncludedChanges()
            val asCheckinPanel = panel as? CheckinProjectPanel
            if (asCheckinPanel != null) return asCheckinPanel.getSelectedChanges().toList()
        }
        val selected = e.getData(VcsDataKeys.SELECTED_CHANGES) ?: e.getData(VcsDataKeys.CHANGES)
        return selected?.toList() ?: emptyList()
    }

    companion object {
        private val LOG = Logger.getInstance(PiGenerateCommitMessageAction::class.java)

        private const val TITLE = "Generating Commit Message with pi"

        /** One-shot text generation; generous because big diffs stream slowly. */
        private const val TIMEOUT_SECONDS = 300L
    }
}
