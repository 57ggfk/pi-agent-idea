package dev.pi.agent.vcs

import com.intellij.openapi.diff.impl.patch.FilePatch
import com.intellij.openapi.diff.impl.patch.PatchLine
import com.intellij.openapi.diff.impl.patch.TextFilePatch

/**
 * Pure building blocks for "Generate Commit Message with pi": unified-diff
 * rendering of the staged patches, the pi prompt, and cleaning pi's reply.
 * Kept free of editor/process dependencies so the tests can exercise them
 * with hand-built [TextFilePatch]s.
 */
object CommitMessageBuilder {

    /** Diff size sent to the model; oversized diffs are truncated (not dropped). */
    const val MAX_DIFF_CHARS = 96_000

    /**
     * Renders patches as a git-style unified diff. Hunk headers are derived
     * from the hunk lines themselves (start line + context/add/remove counts),
     * so 0- vs 1-based line number conventions of the platform types cannot
     * leak into the output. Non-text patches (binary) become a comment line.
     */
    fun unifiedDiff(patches: List<FilePatch>, maxChars: Int = MAX_DIFF_CHARS): String {
        val sb = StringBuilder()
        for (patch in patches) {
            if (sb.length > maxChars) break
            if (patch !is TextFilePatch) {
                sb.appendLine("# binary file changed: ${patch.afterName ?: patch.beforeName ?: "?"}")
                continue
            }
            val before = patch.beforeName ?: "/dev/null"
            val after = patch.afterName ?: "/dev/null"
            sb.appendLine("diff --git a/${if (patch.isNewFile) after else before} b/$after")
            if (patch.isNewFile) sb.appendLine("new file mode 100644")
            if (patch.isDeletedFile) sb.appendLine("deleted file mode 100644")
            sb.appendLine("--- ${if (patch.isNewFile) "/dev/null" else "a/$before"}")
            sb.appendLine("+++ ${if (patch.isDeletedFile) "/dev/null" else "b/$after"}")
            for (hunk in patch.hunks) {
                val lines = hunk.lines
                val beforeCount = lines.count { it.type != PatchLine.Type.ADD }
                val afterCount = lines.count { it.type != PatchLine.Type.REMOVE }
                sb.appendLine("@@ -${hunk.startLineBefore + 1},$beforeCount +${hunk.startLineAfter + 1},$afterCount @@")
                for (line in lines) {
                    sb.append(prefixFor(line.type)).append(line.text).append('\n')
                }
            }
        }
        val text = sb.toString()
        if (text.length <= maxChars) return text
        return text.take(maxChars) + "\n... (diff truncated)"
    }

    private fun prefixFor(type: PatchLine.Type): String = when (type) {
        PatchLine.Type.ADD -> "+"
        PatchLine.Type.REMOVE -> "-"
        PatchLine.Type.CONTEXT -> " "
    }

    fun buildPrompt(diff: String, projectName: String): String =
        "Below is the staged diff of my project \"$projectName\" " +
            "about to be committed. Write the commit message for it.\n" +
            "Rules:\n" +
            "- Conventional Commits format: \"type(scope): summary\".\n" +
            "- First line: imperative summary, max 72 characters, no trailing period.\n" +
            "- Then a blank line and a short body (a few bullet lines) explaining the why, " +
            "only if the change warrants it.\n" +
            "- Reply with ONLY the commit message text, no code fences, no explanations.\n" +
            "- Match the language the changes and diff suggest (file names and content), " +
            "falling back to English when unclear.\n\n" +
            "```diff\n$diff\n```\n"

    /** Strips code fences and surrounding prose that models sometimes add. */
    fun cleanReply(text: String): String {
        var t = text.trim()
        // Single fenced block: take its content.
        if (t.startsWith("```")) {
            t = t.removePrefix("```").substringAfter('\n', "")
            val end = t.lastIndexOf("```")
            if (end >= 0) t = t.take(end)
        }
        return t.trim()
    }
}
