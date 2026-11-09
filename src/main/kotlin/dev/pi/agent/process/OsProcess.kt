package dev.pi.agent.process

import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.util.concurrent.TimeUnit

/**
 * Cross-platform process helpers.
 *
 * Windows differences handled here: `.cmd`/`.bat` shims (as produced by
 * `npm install -g`) cannot be exec'd directly by recent JDKs and must go
 * through `cmd /c`, and the PATH environment separator is `;` rather than
 * `:`. Everything else in the plugin spawns processes through this object.
 */
object OsProcess {

    val isWindows: Boolean =
        System.getProperty("os.name")?.lowercase()?.contains("windows") == true

    /**
     * Charset of *native tool* output on this machine: `where`, `dir` and
     * friends print in the ANSI/OEM code page (`GBK` on zh-CN Windows), not in
     * UTF-8. The JVM default charset is UTF-8 since JDK 18, so decoding their
     * output with the default turns a Chinese install path such as
     * `D:\软件\nodejs\pi.cmd` into `D:\????\nodejs\pi.cmd`, and the resulting
     * "Cannot run program" failure looks like a broken install.
     *
     * `native.encoding` (JEP 400) is exactly this code page. JCEF/pi output,
     * by contrast, is UTF-8 — [decodeOutput] tells the two apart per read.
     */
    val nativeCharset: Charset = runCatching {
        Charset.forName(System.getProperty("native.encoding") ?: "UTF-8")
    }.getOrDefault(Charsets.UTF_8)

    /**
     * Decodes captured process output: UTF-8 when the bytes are valid UTF-8
     * (pi itself, node, our own tools), otherwise the native code page (native
     * Windows utilities), never the lossy replacement-character path.
     *
     * [fallback] is injectable so the Windows code-page branch is testable on
     * a UTF-8 development host: pass `charset("GBK")` explicitly.
     */
    fun decodeOutput(bytes: ByteArray, fallback: Charset = nativeCharset): String {
        if (bytes.isEmpty()) return ""
        val strict = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            strict.decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: CharacterCodingException) {
            String(bytes, fallback)
        }
    }

    /** True when [path] is a Windows cmd shim that must run via `cmd /c`. */
    fun isCmdLike(path: String): Boolean {
        if (!isWindows) return false
        val lower = path.lowercase()
        return lower.endsWith(".cmd") || lower.endsWith(".bat")
    }

    /**
     * Absolute path to the command interpreter that runs `.cmd`/`.bat` shims.
     *
     * Never the bare name `cmd`. CreateProcess resolves a bare name against
     * the *parent process's* own search path, so a stale entry (a same-named
     * file, a directory, a shell wrapper) is enough to turn a perfectly good
     * interpreter into
     * `CreateProcess error=193, %1 is not a valid Win32 application` — and the
     * failure then looks like "pi is broken" while the same command works in
     * an external terminal. `ComSpec` is what Windows itself uses; the
     * well-known location is only a fallback for processes started with a
     * stripped environment.
     */
    val windowsShell: String by lazy { resolveWindowsShell() }

    private fun resolveWindowsShell(): String {
        val candidates = listOfNotNull(
            System.getenv("ComSpec"),
            System.getenv("SystemRoot")?.let { "$it\\System32\\cmd.exe" },
            System.getenv("windir")?.let { "$it\\System32\\cmd.exe" },
            "C:\\Windows\\System32\\cmd.exe",
        )
        return candidates.asSequence()
            .map { it.trim().trim('"') }
            .firstOrNull { it.isNotEmpty() && File(it).isFile }
            // Nothing found: keep the old behaviour rather than refusing to
            // start at all — the error message is clearer than a silent skip.
            ?: "cmd"
    }

    /**
     * Spawnable form of [command]: a `.cmd`/`.bat` executable on Windows is
     * wrapped in `<absolute cmd.exe> /d /c …` (CreateProcess refuses them on
     * recent JDKs); anything else passes through unchanged.
     *
     * `/d` skips the `Command Processor\AutoRun` hook — on a machine with a
     * conda/nvm hook installed every invocation costs ~200 ms and, worse,
     * that hook may rewrite `PATH`, which is exactly what `where pi` and
     * `where node` are asked to resolve. pi and npm need none of it.
     */
    fun launchCommand(command: List<String>): List<String> {
        val head = command.firstOrNull() ?: return command
        return if (isCmdLike(head)) listOf(windowsShell, "/d", "/c") + command else command
    }

    /**
     * Directories every Windows child process is expected to inherit.
     *
     * An IDE launched from a Git Bash / MSYS-derived context can come up with a
     * PATH built only from that shell's entries — observed on a real machine:
     * six directories, none of them `C:\Windows\System32`, because the shell
     * that started the IDE never had it either. The damage is silent and wide:
     * `where`, `findstr`, `reg`, `powershell` and every other system tool
     * disappear from the agent's commands, and the user sees "not found"
     * errors that have nothing to do with what they asked for.
     *
     * `%LOCALAPPDATA%\Microsoft\WindowsApps` is in the same boat and is easy to
     * miss: it holds the **app execution aliases** of every Store-installed
     * tool (PowerShell 7, winget, python…), so losing it makes an installed
     * `pwsh` look like it was never installed at all.
     *
     * Only directories that actually exist are returned, so a non-standard
     * `%SystemRoot%` / `%LOCALAPPDATA%` cannot inject dead entries.
     */
    private fun windowsBaseDirs(): List<String> {
        if (!isWindows) return emptyList()
        val root = sequenceOf(System.getenv("SystemRoot"), System.getenv("windir"), "C:\\Windows")
            .filterNotNull()
            .map { it.trim().trimEnd('\\') }
            .firstOrNull { it.isNotEmpty() }
            ?: return emptyList()
        val storeAliases = System.getenv("LOCALAPPDATA")
            ?.trim()
            ?.trimEnd('\\')
            ?.takeIf { it.isNotEmpty() }
            ?.let { "$it\\Microsoft\\WindowsApps" }
        return listOfNotNull(
            "$root\\system32",
            root,
            "$root\\System32\\Wbem",
            // Windows PowerShell 5.1 lives here; without it `powershell.exe`
            // is unresolvable even though the IDE itself runs fine.
            "$root\\System32\\WindowsPowerShell\\v1.0",
            // Last: app execution aliases are a convenience, not a system dir.
            storeAliases,
        ).filter { File(it).isDirectory }
    }

    /**
     * Machine + user PATH as stored in the registry, expanded and split.
     *
     * The inherited PATH is a snapshot of whatever launched the IDE. On a real
     * machine that was a Git Bash-derived shell, so pi saw 6 entries while the
     * machine's own PATH holds 44 — Java, Maven, Go, WSL, VS Code, conda's
     * `Library\bin` and a dozen personal tool directories were simply absent.
     * Restoring only the system directories fixes `powershell` but leaves every
     * one of those invisible.
     *
     * These are **appended after** the inherited PATH: existing entries keep
     * their precedence, so a tool cannot silently switch version between the
     * IDE and the children it spawns, while the missing ones become reachable.
     *
     * Read once per process — installing something mid-session already needs an
     * IDE restart before the IDE itself can see it.
     */
    private val registryPathDirs: List<String> by lazy { readRegistryPath() }

    private fun readRegistryPath(): List<String> {
        if (!isWindows) return emptyList()
        val reg = sequenceOf(
            System.getenv("SystemRoot")?.let { "$it\\System32\\reg.exe" },
            "C:\\Windows\\System32\\reg.exe",
        ).filterNotNull().firstOrNull { File(it).isFile } ?: return emptyList()
        // Machine first, then user: that is the order Windows composes them in.
        val keys = listOf(
            "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
            "HKCU\\Environment",
        )
        return keys.flatMap { key ->
            val out = runCapture(listOf(reg, "query", key, "/v", "Path", "/reg:64"), 5)
                ?: return@flatMap emptyList()
            parseRegistryPath(out)
                ?.split(File.pathSeparator)
                ?.map { expandEnvVars(it.trim()) }
                ?.filter { it.isNotEmpty() }
                .orEmpty()
        }
    }

    /**
     * Extracts the value from `reg query … /v Path` output, which looks like:
     *
     * ```
     * HKEY_LOCAL_MACHINE\SYSTEM\…\Environment
     *     Path    REG_EXPAND_SZ    %SystemRoot%\system32;…
     * ```
     *
     * `REG_EXPAND_SZ` values still contain `%SystemRoot%`-style references;
     * leaving them unexpanded would hand the child a PATH full of literals that
     * resolve to nothing.
     */
    internal fun parseRegistryPath(output: String): String? {
        for (raw in output.lineSequence()) {
            val line = raw.trim()
            if (!line.startsWith("Path", ignoreCase = true)) continue
            val marker = when {
                line.contains("REG_EXPAND_SZ") -> "REG_EXPAND_SZ"
                line.contains("REG_SZ") -> "REG_SZ"
                else -> continue
            }
            return line.substringAfter(marker).trim().takeIf { it.isNotEmpty() }
        }
        return null
    }

    /** Substitutes `%NAME%` from the IDE's environment; unknown names are kept. */
    internal fun expandEnvVars(value: String): String =
        ENV_REFERENCE.replace(value) { m -> System.getenv(m.groupValues[1]) ?: m.value }

    private fun runCapture(command: List<String>, timeoutSec: Long): String? = try {
        val process = ProcessBuilder(command).redirectErrorStream(true).start()
        val bytes = process.inputStream.use { it.readBytes() }
        if (!process.waitFor(timeoutSec, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            null
        } else {
            decodeOutput(bytes)
        }
    } catch (_: Exception) {
        null
    }

    /**
     * Prepends [extraDirs] to the child's PATH using the OS-correct separator,
     * then rebuilds the rest so it matches what a **terminal** would see.
     *
     * A terminal's PATH is the registry's machine value followed by the user
     * value; the IDE's own PATH is only a snapshot of whatever launched it and
     * can be missing most of it (six entries against 44 on a real machine).
     * Half-merging the two would also change resolution order, so the same
     * command could pick a different binary than it does in a terminal.
     *
     * Order:
     *  1. [extraDirs] — the node directory, so pi and its MCP servers use the
     *     interpreter the plugin resolved, never another install on PATH;
     *  2. the registry's machine + user PATH, i.e. the terminal's PATH;
     *  3. inherited entries the registry does not know about (a shell-specific
     *     `mingw64\bin` and friends), as a last resort.
     *
     * When the registry cannot be read (locked-down machine, reg.exe blocked)
     * this falls back to [windowsBaseDirs] plus the inherited PATH, which is
     * still enough for system tools to resolve.
     */
    fun augmentPathEnv(pb: ProcessBuilder, extraDirs: List<String>) {
        val env = pb.environment()
        val inherited = (env["PATH"] ?: "").split(File.pathSeparator)
        env["PATH"] = mergePath(extraDirs, inherited, registryPathDirs, windowsBaseDirs())
            .joinToString(File.pathSeparator)
    }

    /**
     * The PATH assembly behind [augmentPathEnv], extracted so the ordering and
     * de-duplication rules are testable without a registry (and so a machine
     * where `reg.exe` is blocked still exercises the fallback branch).
     */
    internal fun mergePath(
        extraDirs: List<String>,
        inherited: List<String>,
        registryDirs: List<String>,
        baseDirs: List<String>,
    ): List<String> {
        val entries = if (registryDirs.isEmpty()) {
            extraDirs + baseDirs + inherited
        } else {
            extraDirs + registryDirs + inherited
        }
        val seen = HashSet<String>(entries.size)
        val dirs = ArrayList<String>(entries.size)
        for (raw in entries) {
            val dir = raw.trim()
            if (dir.isEmpty()) continue
            // Windows paths are case-insensitive: C:\Windows and c:\windows are
            // the same entry, and emitting both only bloats every child's env.
            val key = if (isWindows) dir.lowercase() else dir
            // First occurrence wins, so node stays first, the registry keeps its
            // terminal order, and inherited duplicates land at the very end.
            if (seen.add(key)) dirs.add(dir)
        }
        return dirs
    }

    /** `%NAME%` references inside a REG_EXPAND_SZ PATH value. */
    private val ENV_REFERENCE = Regex("%([^%]+)%")
}
