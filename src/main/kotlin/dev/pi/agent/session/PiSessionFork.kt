package dev.pi.agent.session

import com.intellij.openapi.diagnostic.Logger
import java.io.File

/**
 * 024: full-copy fork of a NON-live session ("fork" button on a session list
 * row). pi has no RPC for forking a session that is not the active one — its
 * `clone`/`fork` RPCs both operate on the live session and ignore any path
 * argument, which is exactly how the old list button ended up cloning "the
 * topmost row". The one reliable off-process path is the CLI:
 *
 *     pi --mode rpc --fork <sourceFile>
 *
 * Verified by specs/024-session-list-actions/fork-probe.json (2026-11-12):
 * - the fork is a full entry copy into a new file whose session header points
 *   back at the source via `parentSession`, with `cwd` = the process cwd;
 * - in `--mode rpc` with stdin at EOF the process forks and exits by itself
 *   (exit 0, no model call, no TUI) — stdinText="" closes the pipe right away;
 * - `auth.json` is never touched;
 * - the parent's `session_info` name is copied verbatim, so the (fork) title
 *   suffix is applied afterwards via [PiSessionIndex.renameSessionFile].
 */
object PiSessionFork {
    private val LOG = Logger.getInstance(PiSessionFork::class.java)

    /** How long the one-shot fork process may take before we call it failed. */
    const val TIMEOUT_SECONDS: Long = 30

    /** Pure arg construction, unit-tested without a real pi binary. */
    fun forkArgs(sourceFile: String): List<String> =
        listOf("--mode", "rpc", "--fork", sourceFile)

    data class Forked(val file: String)

    /**
     * Forks [sourceFile] (must live under the sessions root) into the project's
     * session storage and returns the new file. The working directory decides
     * the forked session's `cwd`, so the file shows up in the project's list —
     * the index walks the whole sessions root and filters on the header's cwd.
     * Never touches the live session: no `switch_session`, no RPC.
     */
    fun forkSession(projectPath: String?, sourceFile: String, timeoutSeconds: Long = TIMEOUT_SECONDS): Forked {
        val source = PiSessionIndex.sessionFileFor(sourceFile)
        val root = PiSessionIndex.sessionsRoot()
        val before = PiSessionIndex.snapshotSessionFiles(root)

        val workingDir = projectPath?.let { File(it) }?.takeIf { it.isDirectory }
            ?: File(System.getProperty("user.home"))
        val result = dev.pi.agent.manage.PiCliRunner.run(
            forkArgs(source.absolutePath),
            timeoutSeconds = timeoutSeconds,
            // Empty string, not null: the writer closes the stream → EOF, which
            // is what makes rpc mode exit right after the fork (probe B).
            stdinText = "",
            workingDir = workingDir,
        )
        LOG.info("pi --fork exit=${result.exitCode} for ${source.name}")

        val forked = PiSessionIndex.findNewFork(source.absolutePath, before, root)
            ?: throw IllegalStateException(
                "pi --fork produced no session (exit=${result.exitCode}): " +
                    (result.stderr.ifBlank { result.stdout }).take(200),
            )
        return Forked(forked.absolutePath)
    }
}
