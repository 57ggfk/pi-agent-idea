package dev.pi.agent.title

import dev.pi.agent.process.OsProcess
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TitleGeneratorTest {

    // -- buildCommand ---------------------------------------------------------

    @Test
    fun `command is ephemeral and toolless with the title system prompt`() {
        val cmd = TitleGenerator.buildCommand("/pi", "u", "a", null, null)
        assertTrue(cmd.contains("--no-session"), cmd.toString())
        assertTrue(cmd.contains("--no-tools"), cmd.toString())
        // the real-machine postmortem: extensions/MCP made the one-shot slow
        // and left orphan children holding the output pipe — never load them
        assertTrue(cmd.contains("--no-extensions"), cmd.toString())
        assertTrue(cmd.contains("--no-mcp"), cmd.toString())
        assertTrue(cmd.contains("-p"), cmd.toString())
        val promptAt = cmd.indexOf("--system-prompt")
        assertTrue(promptAt >= 0 && cmd[promptAt + 1].contains("title"), cmd.toString())
    }

    @Test
    fun `provider and model ride along only when both are known`() {
        val with = TitleGenerator.buildCommand("/pi", "u", "a", "openrouter", "openrouter/free")
        assertTrue(with.contains("--provider") && with.contains("openrouter"), with.toString())
        assertTrue(with.contains("--model") && with.contains("openrouter/free"), with.toString())

        val half = TitleGenerator.buildCommand("/pi", "u", "a", "openrouter", null)
        assertTrue(!half.contains("--provider"), half.toString())
    }

    @Test
    fun `the excerpt is a message after the option separator`() {
        val cmd = TitleGenerator.buildCommand("/pi", "user text", "assistant text", null, null)
        val sep = cmd.indexOf("--")
        assertTrue(sep > 0)
        val excerpt = cmd.subList(sep + 1, cmd.size).joinToString(" ")
        assertTrue(excerpt.startsWith("User: user text"), excerpt)
        assertTrue(excerpt.contains("Assistant: assistant text"), excerpt)
    }

    // -- cleanOutput ----------------------------------------------------------

    @Test
    fun `first non-blank line wins, quotes unwrap, whitespace flattens`() {
        assertEquals("Fix the login bug", TitleGenerator.cleanOutput("\n\n  Fix the login bug \n\nexplanation"))
        assertEquals("修复登录 bug", TitleGenerator.cleanOutput("“修复登录 bug”"))
        assertEquals("Title here", TitleGenerator.cleanOutput("`Title here`"))
        // the title is the first line only — anything after a newline is chatter
        assertEquals("a", TitleGenerator.cleanOutput("a\nb"))
    }

    @Test
    fun `blank output is rejected`() {
        assertEquals(null, TitleGenerator.cleanOutput(""))
        assertEquals(null, TitleGenerator.cleanOutput("  \n \n"))
    }

    // -- generate against a fake pi -------------------------------------------

    private fun fakePi(body: String): File =
        File(System.getProperty("java.io.tmpdir"), "fake-pi-${System.nanoTime()}").apply {
            writeText("#!/bin/sh\n$body\n")
            setExecutable(true)
            deleteOnExit()
        }

    @Test
    fun `a happy one-shot returns the cleaned title`() {
        if (OsProcess.isWindows) return // the fake is a /bin/sh script
        val result = TitleGenerator.generate(fakePi("echo '\"Fixed login bug\"'").path, "u", "a", null, null)
        assertEquals("Fixed login bug", result["title"]?.toString()?.trim('"'))
    }

    @Test
    fun `a non-zero exit becomes an error entry, never a title`() {
        if (OsProcess.isWindows) return
        val result = TitleGenerator.generate(fakePi("echo 'API key not found' >&2; exit 1").path, "u", "a", null, null)
        assertTrue(result["error"] != null, result.toString())
        assertTrue(result["title"] == null, result.toString())
    }

    @Test
    fun `blank input is refused without spawning pi`() {
        val result = TitleGenerator.generate("/nonexistent-pi", "  ", "a", null, null)
        assertTrue(result["error"] != null, result.toString())
    }
}
