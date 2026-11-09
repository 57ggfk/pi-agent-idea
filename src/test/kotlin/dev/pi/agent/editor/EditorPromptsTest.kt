package dev.pi.agent.editor

import dev.pi.agent.PiAgentBundle
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Prompt generation for the file/selection actions (spec 009 T007, reworked by
 * spec 015): prompts come from the resource bundle (they follow the IDE
 * language), the file path rides on the reference chip — never in the prompt —
 * and no prompt ever embeds file contents.
 */
class EditorPromptsTest {

    @Test
    fun `file explain prompt is the bundle intent plus the caret suffix`() {
        val text = explainPromptFor(isDirectory = false, where = " (caret at line 12)")
        assertTrue(text.startsWith(PiAgentBundle.message("prompt.explain.file")), text)
        assertTrue(text.endsWith("(caret at line 12)"), text)
    }

    @Test
    fun `directory explain prompt asks for structure and purpose`() {
        val text = explainPromptFor(isDirectory = true)
        assertTrue(text.startsWith(PiAgentBundle.message("prompt.explain.dir")), text)
        assertTrue(text.contains("structure and purpose"), text)
    }

    @Test
    fun `explain prompts carry no path and no code fence`() {
        for (dir in listOf(true, false)) {
            val text = explainPromptFor(dir)
            assertTrue(text.contains("`") == false, "no path may remain in the prompt: $text")
            assertTrue(text.contains("```") == false, "no content may be embedded: $text")
        }
    }

    @Test
    fun `selection prompts interpolate the path and line from the bundle`() {
        val send = PiAgentBundle.message("prompt.sendSelection", "src/A.kt:3")
        assertTrue(send.startsWith("Regarding `src/A.kt:3`"), send)

        val explain = PiAgentBundle.message("prompt.explainSelection", "src/A.kt:3")
        assertTrue(explain.contains("`src/A.kt:3`"), explain)

        val fix = PiAgentBundle.message("prompt.fixSelection", "src/A.kt:3")
        assertTrue(fix.contains("`src/A.kt:3`"), fix)
    }

    @Test
    fun `selection prompts end with a newline before the code block`() {
        val send = PiAgentBundle.message("prompt.sendSelection", "a.kt:1")
        assertTrue(send.endsWith("\n"), send)
    }
}
