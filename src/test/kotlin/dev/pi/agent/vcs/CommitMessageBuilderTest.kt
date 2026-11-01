package dev.pi.agent.vcs

import com.intellij.openapi.diff.impl.patch.PatchHunk
import com.intellij.openapi.diff.impl.patch.PatchLine
import com.intellij.openapi.diff.impl.patch.TextFilePatch
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CommitMessageBuilderTest {

    private fun patch(
        before: String?,
        after: String?,
        hunks: List<PatchHunk> = emptyList(),
        newFile: Boolean = false,
        deleted: Boolean = false,
    ): TextFilePatch = TextFilePatch(Charsets.UTF_8).apply {
        // The platform derives isNewFile/isDeletedFile from the file status.
        when {
            newFile -> {
                beforeName = null
                afterName = after
                setFileStatus(com.intellij.openapi.vcs.FileStatus.ADDED)
            }
            deleted -> {
                beforeName = before
                afterName = null
                setFileStatus(com.intellij.openapi.vcs.FileStatus.DELETED)
            }
            else -> {
                beforeName = before
                afterName = after
            }
        }
        hunks.forEach { addHunk(it) }
    }

    private fun hunk(
        startBefore: Int,
        startAfter: Int,
        vararg lines: Pair<PatchLine.Type, String>,
    ): PatchHunk = PatchHunk(startBefore, startBefore, startAfter, startAfter).apply {
        lines.forEach { (type, text) -> addLine(PatchLine(type, text)) }
    }

    @Test
    fun `modified file renders as unified diff with correct headers`() {
        val diff = CommitMessageBuilder.unifiedDiff(
            listOf(
                patch(
                    before = "src/Foo.kt",
                    after = "src/Foo.kt",
                    hunks = listOf(
                        hunk(
                            2, 2,
                            PatchLine.Type.CONTEXT to "fun a() {}",
                            PatchLine.Type.REMOVE to "fun b() {}",
                            PatchLine.Type.ADD to "fun b(x: Int) {}",
                            PatchLine.Type.CONTEXT to "}",
                        ),
                    ),
                ),
            ),
        )
        val expected = listOf(
            "diff --git a/src/Foo.kt b/src/Foo.kt",
            "--- a/src/Foo.kt",
            "+++ b/src/Foo.kt",
            "@@ -3,3 +3,3 @@", // start lines are 0-based internally, 1-based in the header
            " fun a() {}",
            "-fun b() {}",
            "+fun b(x: Int) {}",
            " }",
            "",
        ).joinToString("\n")
        assertEquals(expected, diff)
    }

    @Test
    fun `new file has dev-null before side and mode marker`() {
        val diff = CommitMessageBuilder.unifiedDiff(
            listOf(
                patch(
                    before = null,
                    after = "src/New.kt",
                    newFile = true,
                    hunks = listOf(hunk(0, 0, PatchLine.Type.ADD to "fun main() {}")),
                ),
            ),
        )
        assertTrue(diff.contains("new file mode 100644"))
        assertTrue(diff.contains("--- /dev/null"))
        assertTrue(diff.contains("+++ b/src/New.kt"))
        assertTrue(diff.contains("diff --git a/src/New.kt b/src/New.kt"))
    }

    @Test
    fun `deleted file has dev-null after side`() {
        val diff = CommitMessageBuilder.unifiedDiff(
            listOf(patch(before = "src/Old.kt", after = null, deleted = true)),
        )
        assertTrue(diff.contains("deleted file mode 100644"))
        assertTrue(diff.contains("--- a/src/Old.kt"))
        assertTrue(diff.contains("+++ /dev/null"))
    }

    @Test
    fun `hunk line counts derive from line types not end fields`() {
        // Constructed with wrong end lines on purpose: counts must come from the lines.
        val diff = CommitMessageBuilder.unifiedDiff(
            listOf(
                patch(
                    before = "a.txt",
                    after = "a.txt",
                    hunks = listOf(
                        hunk(
                            0, 0,
                            PatchLine.Type.CONTEXT to "x",
                            PatchLine.Type.REMOVE to "y1",
                            PatchLine.Type.REMOVE to "y2",
                            PatchLine.Type.ADD to "z",
                        ),
                    ),
                ),
            ),
        )
        assertTrue(diff.contains("@@ -1,3 +1,2 @@"), diff)
    }

    @Test
    fun `oversized diff is truncated not dropped`() {
        val big = patch(
            before = "big.txt",
            after = "big.txt",
            hunks = listOf(hunk(0, 0, PatchLine.Type.ADD to "line".repeat(50_000))),
        )
        val diff = CommitMessageBuilder.unifiedDiff(listOf(big), maxChars = 1000)
        assertTrue(diff.length < CommitMessageBuilder.MAX_DIFF_CHARS + 100)
        assertTrue(diff.endsWith("... (diff truncated)"))
    }

    @Test
    fun `non-text patches render as binary comments`() {
        val diff = CommitMessageBuilder.unifiedDiff(
            listOf(
                object : com.intellij.openapi.diff.impl.patch.FilePatch() {
                    override fun isNewFile() = false
                    override fun isDeletedFile() = false
                }.apply { beforeName = "img.png"; afterName = "img.png" },
            ),
        )
        assertTrue(diff.contains("# binary file changed: img.png"))
        assertFalse(diff.contains("diff --git"))
    }

    @Test
    fun `prompt carries project name and instructions`() {
        val prompt = CommitMessageBuilder.buildPrompt("diff text", "my-project")
        assertTrue(prompt.contains("my-project"))
        assertTrue(prompt.contains("diff text"))
        assertTrue(prompt.contains("Conventional Commits"))
        assertTrue(prompt.contains("72"))
    }

    @Test
    fun `reply cleaning strips code fences`() {
        assertEquals("fix: thing", CommitMessageBuilder.cleanReply("fix: thing"))
        assertEquals("fix: thing", CommitMessageBuilder.cleanReply("```\nfix: thing\n```"))
        assertEquals("fix: thing", CommitMessageBuilder.cleanReply("```diff\nfix: thing\n```"))
        assertEquals("fix: thing", CommitMessageBuilder.cleanReply("  fix: thing  "))
        assertEquals("fix: thing\n\nbody", CommitMessageBuilder.cleanReply("fix: thing\n\nbody"))
    }
}
