package dev.pi.agent.process

import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.util.concurrent.TimeUnit

/** A located pi CLI installation. */
data class PiInstallation(val path: String, val version: String?)

/**
 * Finds the pi CLI on this machine.
 *
 * Order: explicit `PI_AGENT_EXECUTABLE` env var (used by tests) → the PATH of a
 * login shell (covers nvm/volta installs invisible to GUI-launched IDEs) →
 * well-known locations.
 */
object PiLocator {

    private val LOG = Logger.getInstance(PiLocator::class.java)

    @Volatile
    private var cached: PiInstallation? = null

    fun locate(forceRefresh: Boolean = false): PiInstallation? {
        if (!forceRefresh) {
            cached?.let { return it }
        }
        val found = doLocate()
        cached = found
        return found
    }

    private fun doLocate(): PiInstallation? {
        System.getenv("PI_AGENT_EXECUTABLE")?.let { envPath ->
            val f = File(envPath)
            if (f.isFile && f.canExecute()) {
                return PiInstallation(f.absolutePath, version(f.absolutePath))
            }
            LOG.warn("PI_AGENT_EXECUTABLE is set but not executable: $envPath")
        }

        loginShellPath()
            .map { dir -> File(dir, "pi") }
            .firstOrNull { it.isFile && it.canExecute() }
            ?.let { return PiInstallation(it.absolutePath, version(it.absolutePath)) }

        for (candidate in CANDIDATE_PATHS) {
            val f = File(candidate)
            if (f.isFile && f.canExecute()) {
                return PiInstallation(f.absolutePath, version(f.absolutePath))
            }
        }
        return null
    }

    /** `pi --version` output, or null when the binary is not runnable. */
    fun version(path: String): String? = runCapture(listOf(path, "--version"), 10)
        ?.lineSequence()
        ?.firstOrNull { it.isNotBlank() }
        ?.trim()

    /**
     * Directories of the user's login shell PATH. Resolving this is essential
     * because IDEs launched from the Dock/Finder inherit a minimal PATH that
     * typically misses nvm-managed tools like pi.
     */
    fun loginShellPath(): List<String> {
        val shell = System.getenv("SHELL") ?: "/bin/zsh"
        val out = runCapture(listOf(shell, "-lic", "printf '%s' \"\$PATH\""), 10) ?: return emptyList()
        return out.split(":")
            .filter { it.isNotBlank() }
            .distinct()
    }

    private fun runCapture(command: List<String>, timeoutSeconds: Long): String? = try {
        val pb = ProcessBuilder(command).redirectErrorStream(true)
        val proc = pb.start()
        val finished = proc.waitFor(timeoutSeconds, TimeUnit.SECONDS)
        if (!finished) {
            proc.destroyForcibly()
            null
        } else {
            proc.inputStream.bufferedReader().readText()
        }
    } catch (e: Exception) {
        LOG.debug("failed to run ${command.first()}: ${e.message}")
        null
    }

    private val CANDIDATE_PATHS = listOf(
        "${System.getProperty("user.home")}/.local/bin/pi",
        "${System.getProperty("user.home")}/bin/pi",
        "/usr/local/bin/pi",
        "/opt/homebrew/bin/pi",
    )
}
