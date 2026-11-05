package dev.pi.agent.editor

import kotlin.test.Test
import kotlin.test.assertTrue

/** Prompt generation for the file actions (spec 009 T007). */
class EditorPromptsTest {

    @Test
    fun `text file prompt keeps the summarize-and-flag wording with caret`() {
        val text = explainPromptFor(TargetKind.File, "src/A.kt", " (caret at line 12)")
        assertTrue(text.contains("Look at `src/A.kt` (caret at line 12)."), text)
        assertTrue(text.contains("Summarize what this file does"), text)
    }

    @Test
    fun `directory prompt asks for structure and purpose, path only`() {
        val text = explainPromptFor(TargetKind.Directory, "web/src")
        assertTrue(text.contains("directory `web/src`"), text)
        assertTrue(text.contains("structure and purpose"), text)
        assertTrue(text.contains("Read") == false && !text.contains("```"), "no code fence, no content — path only: $text")
    }

    @Test
    fun `binary prompt sends the path only`() {
        val text = explainPromptFor(TargetKind.Binary, "assets/logo.png")
        assertTrue(text.contains("Look at `assets/logo.png`."), text)
        assertTrue(text.contains("```") == false, "binary must not embed content: $text")
    }
}
