package dev.pi.agent.process

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Process output charset handling. Native Windows tools print in the local
 * code page, pi/node print UTF-8; decoding both with the JVM default (UTF-8
 * since JDK 18) is what turned a Chinese install path into `????` and a
 * perfectly good pi installation into "Cannot run program".
 */
class OsProcessTest {

    @Test
    fun `keeps UTF-8 output from pi intact`() {
        val text = "pi 1.4.0 — 中文输出正常"
        assertEquals(text, OsProcess.decodeOutput(text.toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun `decodes a path printed by a native tool in the local code page`() {
        val charset = OsProcess.nativeCharset
        val path = "D:\\软件\\nodejs\\pi.cmd"
        if (!charset.newEncoder().canEncode(path)) return // e.g. a Latin-1 host
        assertEquals(path, OsProcess.decodeOutput(path.toByteArray(charset)))
    }

    @Test
    fun `ascii output is unaffected`() {
        val path = "C:\\Users\\dev\\AppData\\Roaming\\npm\\pi.cmd"
        assertEquals(path, OsProcess.decodeOutput(path.toByteArray(Charsets.US_ASCII)))
    }

    @Test
    fun `empty output decodes to empty string`() {
        assertEquals("", OsProcess.decodeOutput(ByteArray(0)))
    }

    // -- 011 T019: both directions, host-independent ---------------------------

    @Test
    fun `utf-8 emoji from the node side survives`() {
        val text = "更新完成 ✅ pi 1.5.0"
        assertEquals(text, OsProcess.decodeOutput(text.toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun `gbk bytes with a chinese install path decode via the fallback charset`() {
        // Windows native tools print CP936; the fallback is injectable so the
        // branch is exercised on a UTF-8 development host too.
        val path = "D:\\软件\\nodejs\\pi.cmd"
        val gbk = path.toByteArray(charset("GBK"))
        assertEquals(path, OsProcess.decodeOutput(gbk, fallback = charset("GBK")))
    }

    @Test
    fun `misdecoded latin-1 input never produces question marks`() {
        // `Ã©` is what UTF-8 bytes look like when shown as Latin-1; decoding
        // those bytes strictly as UTF-8 yields the original é, never `?`.
        val utf8 = "café".toByteArray(Charsets.UTF_8)
        assertEquals("café", OsProcess.decodeOutput(utf8, fallback = charset("ISO-8859-1")))
        val output = OsProcess.decodeOutput(utf8, fallback = Charsets.US_ASCII)
        assertTrue('?' !in output, "no literal ? expected: $output")
    }

    @Test
    fun `crlf and nul bytes survive decoding`() {
        val bytes = "a\r\nb\rc\u0000d".toByteArray(Charsets.UTF_8)
        // decodeOutput is charset-only: line endings are drainThread's job
        assertEquals("a\r\nb\rc\u0000d", OsProcess.decodeOutput(bytes))
    }

    @Test
    fun `one long line without newlines decodes completely`() {
        val text = "x".repeat(300_000)
        assertEquals(text, OsProcess.decodeOutput(text.toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun `windows shell is an absolute path, never the bare name`() {
        if (!OsProcess.isWindows) return
        val shell = OsProcess.windowsShell
        // A bare `cmd` is resolved against the IDE process's own search path;
        // when that lands on a non-executable file CreateProcess answers
        // "error=193, %1 is not a valid Win32 application" and pi looks broken.
        assertTrue(File(shell).isAbsolute, "expected an absolute path, got $shell")
        assertTrue(shell.lowercase().endsWith("cmd.exe"), "expected cmd.exe, got $shell")
    }

    // -- child PATH assembly -------------------------------------------------

    private fun childPath(extraDirs: List<String>, inherited: String): List<String> {
        val pb = ProcessBuilder("no-such-command")
        pb.environment()["PATH"] = inherited
        OsProcess.augmentPathEnv(pb, extraDirs)
        return pb.environment()["PATH"]!!.split(File.pathSeparator).filter { it.isNotEmpty() }
    }

    private fun systemRoot(): String =
        (System.getenv("SystemRoot") ?: System.getenv("windir") ?: "C:\\Windows").trimEnd('\\')

    @Test
    fun `extra dirs come first so the injected node wins`() {
        val dirs = childPath(listOf("D:\\node"), inherited = "C:\\existing")
        assertEquals("D:\\node", dirs.first())
        assertTrue(dirs.any { it.equals("C:\\existing", ignoreCase = true) }, "inherited PATH kept: $dirs")
    }

    @Test
    fun `windows child PATH regains the system directories it was missing`() {
        if (!OsProcess.isWindows) return
        val root = systemRoot()
        if (!File(root).isDirectory) return

        // The real-machine case: a PATH made only of Git Bash / conda / node
        // entries, with no system32 at all.
        val dirs = childPath(emptyList(), inherited = "C:\\Users\\dev\\bin;C:\\Program Files\\Git\\mingw64\\bin")
        val lowered = dirs.map { it.lowercase() }

        assertTrue(
            lowered.contains("${root.lowercase()}\\system32"),
            "system32 must be restored, got $dirs",
        )
        assertTrue(lowered.contains(root.lowercase()), "Windows dir must be restored, got $dirs")
    }

    @Test
    fun `a system directory already on PATH is not duplicated`() {
        if (!OsProcess.isWindows) return
        val root = systemRoot()
        if (!File(root).isDirectory) return

        val dirs = childPath(emptyList(), inherited = "$root\\system32;C:\\other")
        val occurrences = dirs.count { it.equals("$root\\system32", ignoreCase = true) }
        assertEquals(1, occurrences, "expected one system32 entry, got $dirs")
    }

    @Test
    fun `store app aliases stay reachable so an installed pwsh is found`() {
        if (!OsProcess.isWindows) return
        val localAppData = System.getenv("LOCALAPPDATA") ?: return
        val windowsApps = File(localAppData, "Microsoft${File.separator}WindowsApps")
        if (!windowsApps.isDirectory) return // host without the alias directory

        val dirs = childPath(emptyList(), inherited = "C:\\Users\\dev\\bin")
        assertTrue(
            dirs.any { it.equals(windowsApps.absolutePath, ignoreCase = true) },
            "WindowsApps must be on the child PATH, got $dirs",
        )
    }

    @Test
    fun `blank entries are dropped and the rest keep their order`() {
        val dirs = childPath(
            listOf("D:\\node", "  "),
            // Built with the host separator so the case holds on Unix too.
            inherited = listOf("C:\\b", "", "C:\\a").joinToString(File.pathSeparator),
        )
        assertEquals("D:\\node", dirs.first())
        val tail = dirs.dropWhile { !it.equals("C:\\b", ignoreCase = true) }
        assertTrue(tail.size >= 2, "expected inherited order b,a; got $dirs")
        assertTrue(dirs.none { it.isBlank() }, "no blank entries: $dirs")
    }

    // -- registry PATH (what the IDE itself never inherited) ------------------

    @Test
    fun `registry PATH value is read from reg query output`() {
        val out = """
            HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment
                Path    REG_EXPAND_SZ    %SystemRoot%\system32;%ProgramFiles%\Git\cmd
        """.trimIndent()
        assertEquals(
            "%SystemRoot%\\system32;%ProgramFiles%\\Git\\cmd",
            OsProcess.parseRegistryPath(out),
        )
    }

    @Test
    fun `plain REG_SZ values parse too and unrelated rows are ignored`() {
        if (!OsProcess.isWindows) return
        val out = "HKEY_CURRENT_USER\\Environment\n" +
            "    TEMP    REG_SZ    C:\\Temp\n" +
            "    Path    REG_SZ    D:\\tools;C:\\bin\n"
        assertEquals("D:\\tools;C:\\bin", OsProcess.parseRegistryPath(out))
    }

    @Test
    fun `a missing Path value yields null instead of an empty entry`() {
        assertNull(OsProcess.parseRegistryPath("HKEY_CURRENT_USER\\Environment\n\n"))
        assertNull(OsProcess.parseRegistryPath(""))
    }

    @Test
    fun `expandEnvVars substitutes known names and keeps unknown ones`() {
        if (!OsProcess.isWindows) return
        val root = System.getenv("SystemRoot") ?: return
        val expanded = OsProcess.expandEnvVars("%SystemRoot%\\system32;%NOT_A_REAL_VAR_XYZ%\\bin")
        assertEquals("$root\\system32;%NOT_A_REAL_VAR_XYZ%\\bin", expanded)
    }

    @Test
    fun `an inherited entry is never duplicated by the merge`() {
        val dirs = childPath(emptyList(), inherited = listOf("C:\\a", "C:\\b").joinToString(File.pathSeparator))
        assertEquals(1, dirs.count { it.equals("C:\\a", ignoreCase = true) }, "got $dirs")
        assertEquals(1, dirs.count { it.equals("C:\\b", ignoreCase = true) }, "got $dirs")
    }

    @Test
    fun `registry order wins so a command resolves as it does in a terminal`() {
        val merged = OsProcess.mergePath(
            extraDirs = listOf("D:\\node"),
            inherited = listOf("C:\\ide-shell\\bin", "C:\\Windows\\System32"),
            registryDirs = listOf("C:\\Windows\\System32", "C:\\tools\\java\\bin"),
            baseDirs = emptyList(),
        )
        // node first, then the registry order verbatim, then only what the
        // registry did not cover — never a half-merge that reorders tools.
        assertEquals(
            listOf("D:\\node", "C:\\Windows\\System32", "C:\\tools\\java\\bin", "C:\\ide-shell\\bin"),
            merged,
        )
    }

    @Test
    fun `registry-only entries stay complete instead of being trimmed to base dirs`() {
        val merged = OsProcess.mergePath(
            extraDirs = emptyList(),
            inherited = listOf("C:\\ide-shell\\bin"),
            registryDirs = listOf("C:\\Windows\\System32", "C:\\tools\\go\\bin", "C:\\tools\\maven\\bin"),
            baseDirs = emptyList(),
        )
        assertTrue(merged.containsAll(listOf("C:\\tools\\go\\bin", "C:\\tools\\maven\\bin")), "got $merged")
    }

    @Test
    fun `unreadable registry falls back to the base directories`() {
        val merged = OsProcess.mergePath(
            extraDirs = listOf("D:\\node"),
            inherited = listOf("C:\\ide-shell\\bin"),
            registryDirs = emptyList(),
            baseDirs = listOf("C:\\Windows\\System32", "C:\\Windows"),
        )
        assertEquals(
            listOf("D:\\node", "C:\\Windows\\System32", "C:\\Windows", "C:\\ide-shell\\bin"),
            merged,
        )
    }
}
