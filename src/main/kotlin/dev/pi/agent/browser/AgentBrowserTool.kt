package dev.pi.agent.browser

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Executes the pi_browser tool's requests against the tool-window browser
 * tab (spec 049 D2/D8). Runs on the LocalUiServer HTTP executor thread; every
 * Swing/EDT touch hops through invokeAndWait, and the load-completion wait is
 * a plain @Volatile-state poll — never an EDT block (plan §风险).
 *
 * The agent drives ONLY the tool-window carrier kernel (plan D8): no second
 * windowed browser is ever created here (048 P-7), and the editor carrier is
 * unaffected.
 */
object AgentBrowserTool {

    /** Hard ceiling for one open/reload load wait (spec 049 Q5). */
    private const val LOAD_WAIT_MS = 15_000L
    private const val POLL_INTERVAL_MS = 100L

    /**
     * How long `open` waits for the browser tab to actually appear.
     * `PiBrowserManager.open` hops to the EDT via invokeLater — on a cold IDE
     * (tab never opened) the content is created a few ticks later, and a
     * one-shot panel lookup races it and wrongly reports "tool window
     * unavailable" (真机反向用例 2026-11-19 实测踩中).
     */
    private const val PANEL_WAIT_MS = 5_000L

    fun execute(project: Project, request: AgentBrowserRequest, bridgeToken: String?): JsonObject {
        val violation = AgentBrowserRequestCodec.bridgeTokenViolation(request.url, bridgeToken)
        if (violation != null) return failure(violation)

        return when (request.action) {
            AgentAction.READ -> read(project)
            AgentAction.OPEN -> open(project, request.url ?: "")
            AgentAction.RELOAD -> reload(project)
        }
    }

    /**
     * F-214: `open` without a URL runs the loopback dev-server probe
     * ([DevServerProbe]) and reports what it found — the agent skips one
     * shell round-trip per verification. The plugin's own UI-server port is
     * excluded (that is the chat SPA, never a dev server).
     */
    private fun open(project: Project, url: String): JsonObject {
        var normalized: String?
        var autoDetected = false
        var candidates: List<Int> = emptyList()
        if (url.isBlank()) {
            val exclude = runCatching {
                setOf(dev.pi.agent.ui.LocalUiServer.getInstance().port)
            }.getOrElse { emptySet() }
            val probe = DevServerProbe.detect(excludePorts = exclude)
            candidates = probe.candidates
            normalized = probe.detected
            autoDetected = normalized != null
            if (normalized == null) {
                return buildJsonObject {
                    put("ok", false)
                    put(
                        "reason",
                        if (candidates.isEmpty()) {
                            "no loopback dev server found to auto-detect (nothing listening); start the dev server or pass url explicitly"
                        } else {
                            "no dev server answered among $candidates loopback listener(s) probed; pass url explicitly if it serves a non-HTML root"
                        },
                    )
                }
            }
        } else {
            normalized = UrlNormalizer.normalizeAddressBar(url)
                ?: return failure("not a usable url: ${LogSafe.url(url)}")
        }
        val manager = PiBrowserManager.getInstance(project)
        manager.open(normalized) // hops to EDT internally, creates/selects the tab
        val panel = pollUntil(PANEL_WAIT_MS) { manager.browserPanel() }
            ?: return failure("browser tool window is unavailable", normalized)
        // Wait for the navigate to at least start before polling, so a stale
        // LOADED from the previous page cannot pass as the new page's state.
        if (runOnEdt { panel.agentLoad(normalized) } == null) {
            return failure("browser tab did not initialize", normalized)
        }
        val kernel = panel.agentKernel()
        val state = waitForLoad(kernel)
        return finishWithSnapshot(kernel, state, autoDetected, candidates)
    }

    private fun reload(project: Project): JsonObject {
        val manager = PiBrowserManager.getInstance(project)
        val panel = manager.browserPanel()
            ?: return failure("browser tab is not open; use open first")
        if (runOnEdt { panel.agentReload() } == null) {
            return failure("browser tab did not initialize")
        }
        val kernel = panel.agentKernel()
        val state = waitForLoad(kernel)
        return finishWithSnapshot(kernel, state)
    }

    private fun read(project: Project): JsonObject {
        val manager = PiBrowserManager.getInstance(project)
        val panel = manager.browserPanel()
            ?: return failure("browser tab is not open; use open first")
        return finishWithSnapshot(panel.agentKernel(), panel.agentKernel().state.name)
    }

    private fun finishWithSnapshot(
        kernel: PiBrowserKernel,
        state: String,
        autoDetected: Boolean = false,
        candidates: List<Int> = emptyList(),
    ): JsonObject {
        val snapshot = try {
            kernel.readPage().get(PageSnapshotSanitizer.MAX_TEXT_CHARS.toLong() + 5_000L, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            PageSnapshot.failure("read did not return: " + LogSafe.truncate(e.message), kernel.lastKnownUrl)
        }
        // F-206: the page's recent console errors ride along on every answer —
        // success or failure — so the model sees WHY a page misbehaves instead
        // of guessing from an empty text excerpt. Bounded by the buffer itself.
        val console = kernel.recentConsoleLines(5)
        if (!snapshot.ok) {
            return buildJsonObject {
                put("ok", false)
                put("reason", snapshot.reason ?: "page snapshot failed")
                put("state", state)
                put("url", snapshot.url)
                appendConsole(console)
            }
        }
        return buildJsonObject {
            put("ok", true)
            put("state", state)
            put("url", snapshot.url)
            put("title", snapshot.title)
            put("ready", snapshot.readyState)
            put("text", snapshot.text)
            if (autoDetected) {
                put("detected", true)
                put("candidates", buildJsonArray { candidates.forEach { add(it) } })
            }
            appendConsole(console)
        }
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.appendConsole(console: List<String>) {
        if (console.isEmpty()) return
        put("console", buildJsonArray { console.forEach { add(it) } })
    }

    /** Polls the kernel state machine until a terminal load state or the deadline. */
    private fun waitForLoad(kernel: PiBrowserKernel): String {
        val deadline = System.currentTimeMillis() + LOAD_WAIT_MS
        while (System.currentTimeMillis() < deadline) {
            val state = kernel.state
            if (state == PiBrowserState.LOADED || state == PiBrowserState.FAILED || state == PiBrowserState.CRASHED) {
                return state.name
            }
            Thread.sleep(POLL_INTERVAL_MS)
        }
        return "TIMEOUT"
    }

    /**
     * Generic bounded poll (also used by tests). Returns the first non-null
     * [supplier] result, or null once [timeoutMs] has elapsed.
     */
    internal fun <T> pollUntil(timeoutMs: Long, intervalMs: Long = POLL_INTERVAL_MS, supplier: () -> T?): T? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            supplier()?.let { return it }
            if (System.currentTimeMillis() >= deadline) return null
            Thread.sleep(intervalMs)
        }
    }

    /** EDT hop for the load/attach Swing work; false when the IDE is shutting down. */
    private fun runOnEdt(block: Runnable): Boolean {
        return try {
            val app = ApplicationManager.getApplication()
            if (app.isDispatchThread) {
                block.run()
            } else {
                app.invokeAndWait(Runnable { block.run() })
            }
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun failure(reason: String, url: String = ""): JsonObject = buildJsonObject {
        put("ok", false)
        put("reason", reason)
        if (url.isNotBlank()) put("url", url)
    }
}
