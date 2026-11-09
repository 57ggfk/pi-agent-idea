package dev.pi.agent.title

import java.io.File
import org.junit.jupiter.api.condition.EnabledOnOs
import org.junit.jupiter.api.condition.OS
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class TitleGeneratorTest {

    // -- buildCommand ---------------------------------------------------------

    @Test
    fun `command is ephemeral and toolless with the title system prompt`() {
        val cmd = TitleGenerator.buildCommand("/pi", null, null)
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
        val with = TitleGenerator.buildCommand("/pi", "openrouter", "openrouter/free")
        assertTrue(with.contains("--provider") && with.contains("openrouter"), with.toString())
        assertTrue(with.contains("--model") && with.contains("openrouter/free"), with.toString())

        val half = TitleGenerator.buildCommand("/pi", "openrouter", null)
        assertTrue(!half.contains("--provider"), half.toString())
    }

    /**
     * The Windows regression (0.5.6): `pi` is a `.cmd` shim there, so the spawn
     * runs through `cmd.exe /d /c`, where a newline in an argument ends the
     * command line and a quote re-splits it. Every argv entry must therefore be
     * single-line, quote-free, percent-free — and carry no conversation text.
     */
    @Test
    fun `no argument can be mangled by cmd exe`() {
        val cmd = TitleGenerator.buildCommand("/pi", "openrouter", "openrouter/free")
        for (arg in cmd) {
            assertTrue(!arg.contains('\n') && !arg.contains('\r'), "newline in argv: $arg")
            assertTrue(!arg.contains('"'), "quote in argv: $arg")
            assertTrue(!arg.contains('%'), "percent in argv: $arg")
        }
        assertTrue(cmd.none { it.contains("User:") }, cmd.toString())
    }

    // -- prompt (stdin payload) -----------------------------------------------

    @Test
    fun `the excerpt travels on stdin, keeping both sides and its own lines`() {
        val prompt = TitleGenerator.prompt("user text", "assistant text")
        assertTrue(prompt.startsWith("User: user text"), prompt)
        assertTrue(prompt.contains("\n\nAssistant: assistant text"), prompt)
        assertTrue(prompt.endsWith("\n"), "pi wants a terminated line")
    }

    @Test
    fun `both sides are clipped by code point, never mid-character`() {
        val prompt = TitleGenerator.prompt("标".repeat(2000), "回".repeat(2000))
        val user = prompt.substringAfter("User: ").substringBefore("\n\nAssistant: ")
        val assistant = prompt.substringAfter("Assistant: ").trim()
        assertEquals(800, user.length)
        assertEquals(400, assistant.length)
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

    /** A `.cmd` shim with the same shape as pi's own: it reads the stdin prompt. */
    private fun fakePiCmd(dump: File): File {
        val dir = File(System.getProperty("java.io.tmpdir"), "fake-pi-cmd-${System.nanoTime()}").apply { mkdirs() }
        return File(dir, "pi.cmd").apply {
            writeText(
                "@echo off\r\n" +
                    "findstr \"^\" > \"${dump.absolutePath}\"\r\n" +
                    "echo Fixed title\r\n",
            )
            deleteOnExit()
        }
    }

    @Test
    @EnabledOnOs(OS.MAC, OS.LINUX) // the fake is a /bin/sh script
    fun `a happy one-shot returns the cleaned title`() {
        val result = TitleGenerator.generate(fakePi("echo '\"Fixed login bug\"'").path, "u", "a", null, null)
        assertEquals("Fixed login bug", result["title"]?.toString()?.trim('"'))
    }

    /**
     * Windows-only: proves the excerpt reaches pi through the real `cmd /d /c`
     * spawn path. With the old argv-based design this case received nothing
     * (the command line was cut at the excerpt's first newline) and returned
     * an empty title.
     */
    @Test
    @EnabledOnOs(OS.WINDOWS)
    fun `the excerpt reaches a cmd shim through stdin`() {
        val dump = File(System.getProperty("java.io.tmpdir"), "fake-pi-stdin-${System.nanoTime()}.txt")
        dump.deleteOnExit()
        val result = TitleGenerator.generate(fakePiCmd(dump).absolutePath, "hello\nworld", "assistant reply", null, null)
        assertEquals("Fixed title", result["title"]?.toString()?.trim('"'), result.toString())
        val seen = assertNotNull(dump.takeIf { it.isFile }?.readText(), "the shim saw no stdin").replace("\r\n", "\n")
        assertTrue(seen.contains("User: hello"), seen)
        assertTrue(seen.contains("world"), "the user's second line survived cmd")
        assertTrue(seen.contains("Assistant: assistant reply"), seen)
    }

    @Test
    @EnabledOnOs(OS.MAC, OS.LINUX) // the fake is a /bin/sh script
    fun `a non-zero exit becomes an error entry, never a title`() {
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
