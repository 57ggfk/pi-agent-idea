package dev.pi.agent.browser

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Executes the pi_browser tool's requests against the browser (spec 049
 * D2/D8, 054 agent dual-form). Runs on the LocalUiServer HTTP executor
 * thread; every Swing/EDT touch hops through invokeAndWait, and the
 * load-completion wait is a plain @Volatile-state poll — never an EDT block
 * (plan §风险).
 *
 * 054 agent dual-form (user-directed "AI 两种形态都支持"): an explicit
 * `target` picks the tool-window tab or the editor-form preview; a
 * target-less call follows [PiBrowserManager.lastAgentCarrier] — the form
 * the agent last opened into — so open + follow-up read/scroll/console hit
 * the same kernel. The tool-window tab count rules (048 P-7) are unchanged:
 * this creates no extra windowed browser there, and the editor carrier's
 * kernel belongs to its own preview tab.
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

    // ---- 053 constants (internal: the copy is unit-locked) ----

    /** Shared empty-tab failure for read/reload/scroll/console. */
    internal const val NO_TAB_REASON = "browser tab is not open; use open first"

    /** 053 B2: scroll defaults — one "page-ish" step down. */
    internal const val DEFAULT_SCROLL_DIRECTION = "down"
    internal const val DEFAULT_SCROLL_AMOUNT_PX = 800

    /** 053 B3: console preview size (the full history lives in the JSONL file). */
    internal const val DEFAULT_CONSOLE_PREVIEW_LINES = 20
    internal const val MAX_CONSOLE_PREVIEW_LINES = AgentBrowserRequestCodec.MAX_CONSOLE_LIMIT
    internal const val CONSOLE_EMPTY_REASON =
        "no console error/warning lines captured yet; only error and warning levels are kept"

    fun execute(project: Project, request: AgentBrowserRequest, bridgeToken: String?): JsonObject {
        val violation = AgentBrowserRequestCodec.bridgeTokenViolation(request.url, bridgeToken)
        if (violation != null) return failure(violation)

        return when (request.action) {
            AgentAction.READ -> read(project, request)
            AgentAction.OPEN -> open(project, request)
            AgentAction.RELOAD -> reload(project, request)
            AgentAction.SCROLL -> scroll(project, request)
            AgentAction.CONSOLE -> console(project, request)
            AgentAction.LIST -> list(project)
            AgentAction.CLICK -> click(project, request)
            AgentAction.TYPE -> type(project, request)
            AgentAction.EVALUATE -> evaluate(project, request)
        }
    }

    /**
     * 054 agent dual-form: explicit `target` ("tab"/"editor", codec-validated)
     * picks the carrier; absent → the carrier the agent LAST opened into
     * (tool-window default) — the "AI decides by situation" contract, where
     * the situation is what the agent itself did earlier in this project.
     */
    internal fun resolveCarrier(project: Project, target: String?): BrowserCarrier =
        BrowserCarriers.carrierFor(target)
            ?: PiBrowserManager.getInstance(project).lastAgentCarrier

    // ---- 056 页签寻址: panel resolution by identity ----

    /**
     * The outcome of panel resolution for one agent request: either a live
     * [panel] plus the tab id the answer stamps ([tabId], null when the panel
     * carries no id — responses then omit "tab"), or the model-readable
     * [missReason].
     */
    internal data class PanelLookup<P>(val panel: P?, val tabId: String?, val missReason: String?)

    /**
     * 056 resolution order, pure over lambdas (unit-locked in
     * AgentBrowserToolTabAddressingTest; the production wrapper below wires
     * them to the manager):
     *
     *  1. explicit `tab` param → panelById — a miss is a MODEL-READABLE
     *     failure ("no browser tab t9"), never a silent fallback: the model
     *     asked for THAT panel and must learn it is gone;
     *  2. [lastTabId] — the tab the last open landed on (identity beats
     *     form, survives manual tab switching); a stale id (tab closed)
     *     degrades to the carrier fallback;
     *  3. the 055 carrier fallback (lastAgentCarrier / selected tab).
     *
     * `tab` wins over `target` when both are present: the codec accepts both,
     * and the tool layer gives the narrower address (an exact panel id)
     * precedence over the carrier form — [target] only feeds step 3.
     */
    internal fun <P> resolveAgentPanel(
        explicitTab: String?,
        lastTabId: String?,
        carrier: BrowserCarrier,
        panelById: (String) -> P?,
        panelForCarrier: (BrowserCarrier) -> P?,
        tabIdOf: (P) -> String?,
    ): PanelLookup<P> {
        if (explicitTab != null) {
            val panel = panelById(explicitTab)
            return if (panel == null) {
                PanelLookup(null, null, "no browser tab $explicitTab; use the list action to see live tab ids")
            } else {
                PanelLookup(panel, tabIdOf(panel), null)
            }
        }
        val last = lastTabId?.let(panelById)
        val panel = last ?: panelForCarrier(carrier)
        return if (panel == null) PanelLookup(null, null, NO_TAB_REASON) else PanelLookup(panel, tabIdOf(panel), null)
    }

    /** Production wiring of [resolveAgentPanel] to the project's manager. */
    private fun resolveAgentPanel(project: Project, request: AgentBrowserRequest): PanelLookup<BrowserPanel> {
        val manager = PiBrowserManager.getInstance(project)
        return resolveAgentPanel(
            explicitTab = request.tab,
            lastTabId = manager.lastTabId,
            carrier = resolveCarrier(project, request.target),
            panelById = manager::panelById,
            panelForCarrier = manager::agentPanel,
            tabIdOf = manager::tabIdOf,
        )
    }

    /**
     * F-214: `open` without a URL runs the loopback dev-server probe
     * ([DevServerProbe]) and reports what it found — the agent skips one
     * shell round-trip per verification. The plugin's own UI-server port is
     * excluded (that is the chat SPA, never a dev server).
     *
     * 056: an explicit `tab` pins the landing panel — the request navigates
     * THAT panel instead of the carrier-based open (tab wins over target;
     * the landing is recorded in [PiBrowserManager.lastTabId]). Without a
     * tab, the 055 carrier open is byte-for-byte unchanged (F-208 reuse /
     * new-tab rules), and the landed panel's id rides in the answer.
     */
    private fun open(project: Project, request: AgentBrowserRequest): JsonObject {
        val url = request.url ?: ""
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
        // 056: an explicit tab id navigates THAT exact panel (codec checked
        // the format; a dead id is a runtime miss answered model-readably).
        request.tab?.let { tabId ->
            val pinned = manager.panelById(tabId)
                ?: return failure("no browser tab $tabId; use the list action to see live tab ids", normalized)
            if (runOnEdt { pinned.agentLoad(normalized) } == null) {
                return failure("browser tab did not initialize", normalized, tabId)
            }
            val kernel = pinned.agentKernel()
            val state = waitForLoad(kernel)
            manager.recordLastTabId(tabId)
            return finishWithSnapshot(kernel, state, autoDetected, candidates, tab = tabId)
        }
        val carrier = resolveCarrier(project, request.target)
        // F-208 round 2: open returns the exact panel it landed on (EDT-exact,
        // no selection-lag guesswork) — the walkthrough caught the poll-based
        // lookup navigating the PREVIOUSLY selected tab as well.
        val panel = manager.open(normalized, carrier)
            ?: return failure(
                if (carrier == BrowserCarrier.EDITOR) "browser editor tab is unavailable"
                else "browser tool window is unavailable",
                normalized,
            )
        // Wait for the navigate to at least start before polling, so a stale
        // LOADED from the previous page cannot pass as the new page's state.
        if (runOnEdt { panel.agentLoad(normalized) } == null) {
            return failure("browser tab did not initialize", normalized)
        }
        val kernel = panel.agentKernel()
        val state = waitForLoad(kernel)
        return finishWithSnapshot(kernel, state, autoDetected, candidates, tab = manager.tabIdOf(panel))
    }

    /**
     * 056: reload resolves the panel by identity (explicit tab → last-open
     * tab → 055 carrier fallback) instead of only by carrier form.
     */
    private fun reload(project: Project, request: AgentBrowserRequest): JsonObject {
        val lookup = resolveAgentPanel(project, request)
        val panel = lookup.panel ?: return failure(lookup.missReason ?: NO_TAB_REASON)
        if (runOnEdt { panel.agentReload() } == null) {
            return failure("browser tab did not initialize", tab = lookup.tabId)
        }
        val kernel = panel.agentKernel()
        val state = waitForLoad(kernel)
        return finishWithSnapshot(kernel, state, tab = lookup.tabId)
    }

    private fun read(project: Project, request: AgentBrowserRequest): JsonObject {
        val lookup = resolveAgentPanel(project, request)
        val panel = lookup.panel ?: return failure(lookup.missReason ?: NO_TAB_REASON)
        val kernel = panel.agentKernel()
        // 053 B2: a selector excerpts that element instead of the whole page.
        return finishWithSnapshot(
            kernel,
            kernel.state.name,
            selector = request.selector,
            format = request.format,
            tab = lookup.tabId,
        )
    }

    /**
     * 053 B2: move the viewport (the D4 revision — read-only DOM + viewport
     * scrolling), then answer with the SAME snapshot format, the post-scroll
     * `scrollY` attached. The kernel owns the single-flight and the timeout;
     * a failed scroll answers with a plain failure, never a stale snapshot.
     */
    private fun scroll(project: Project, request: AgentBrowserRequest): JsonObject {
        val lookup = resolveAgentPanel(project, request)
        val panel = lookup.panel ?: return failure(lookup.missReason ?: NO_TAB_REASON)
        val kernel = panel.agentKernel()
        val direction = request.scrollDirection ?: DEFAULT_SCROLL_DIRECTION
        val amount = request.scrollAmount ?: DEFAULT_SCROLL_AMOUNT_PX
        val result = try {
            kernel.scrollPage(direction, amount).get(LOAD_WAIT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            ScrollResult.failure("scroll did not return: " + LogSafe.truncate(e.message))
        }
        if (!result.ok) {
            return failure(result.reason ?: "scroll failed", kernel.lastKnownUrl, tab = lookup.tabId)
        }
        return finishWithSnapshot(kernel, kernel.state.name, scrollY = result.scrollY, tab = lookup.tabId)
    }

    /**
     * 053 B3: on-demand console readback — `{ok,total,dropped,count,lines,
     * file}`. `count` is how many lines match `since` (the full scale);
     * `lines` is the bounded preview (default 20, max 200, each line already
     * LogSafe.truncate'd at capture). Older lines live in the JSONL file the
     * response names — the agent greps it instead of the plugin shipping the
     * whole history into the context.
     */
    private fun console(project: Project, request: AgentBrowserRequest): JsonObject {
        val lookup = resolveAgentPanel(project, request)
        val panel = lookup.panel ?: return failure(lookup.missReason ?: NO_TAB_REASON)
        val kernel = panel.agentKernel()
        val since = (request.consoleSince ?: 0).coerceAtLeast(0)
        val limit = (request.consoleLimit ?: DEFAULT_CONSOLE_PREVIEW_LINES)
            .coerceIn(1, MAX_CONSOLE_PREVIEW_LINES)
        val window = kernel.consoleWindow(since, limit)
        return consoleResponse(window, since, kernel.consoleFilePath(), tab = lookup.tabId)
    }

    /**
     * 056 LIST: enumerate the live browser panels across BOTH carriers —
     * `{ok, tabs:[{tab,url,title,carrier,selected}]}`. URL/title come from
     * the kernel's last-known values, so a mid-load tab still answers; the
     * ids it returns are the addresses every other action accepts.
     */
    private fun list(project: Project): JsonObject =
        listResponse(PiBrowserManager.getInstance(project).listTabs())

    // ---- 057 浏览器操作层: click / type / evaluate ----

    /**
     * 057 CLICK: synthetic mouse event sequence on the matched element. The
     * execution mirrors scroll's contract: a completed round-trip (hit OR
     * miss) answers with the page snapshot + the click verdict; a dead
     * round-trip (no page/timeout/throw) is a plain model-readable failure.
     * The matched element's text is named `elementText` — the snapshot's own
     * `text` field already occupies the name.
     */
    private fun click(project: Project, request: AgentBrowserRequest): JsonObject {
        val lookup = resolveAgentPanel(project, request)
        val panel = lookup.panel ?: return failure(lookup.missReason ?: NO_TAB_REASON)
        val kernel = panel.agentKernel()
        val selector = request.selector ?: return failure("action click requires a selector", tab = lookup.tabId)
        val result = try {
            kernel.clickElement(selector).get(LOAD_WAIT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            ActionResult.failure("click did not return: " + LogSafe.truncate(e.message))
        }
        if (!result.ok) {
            return actionFailure(result.reason ?: "click failed", result.error, kernel.lastKnownUrl, lookup.tabId)
        }
        val verdict = if (result.found == true) {
            buildJsonObject {
                put("found", true)
                result.tag?.let { put("tag", it) }
                result.text?.let { put("elementText", it) }
            }
        } else {
            buildJsonObject {
                put("found", false)
                put("reason", result.reason ?: "element not found")
            }
        }
        return finishWithSnapshot(kernel, kernel.state.name, tab = lookup.tabId, actionFields = verdict)
    }

    /** 057 TYPE: write [request.text] into the matched element (React-compatible). */
    private fun type(project: Project, request: AgentBrowserRequest): JsonObject {
        val lookup = resolveAgentPanel(project, request)
        val panel = lookup.panel ?: return failure(lookup.missReason ?: NO_TAB_REASON)
        val kernel = panel.agentKernel()
        val selector = request.selector ?: return failure("action type requires a selector", tab = lookup.tabId)
        val text = request.text ?: return failure("action type requires text", tab = lookup.tabId)
        val result = try {
            kernel.typeText(selector, text).get(LOAD_WAIT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            ActionResult.failure("type did not return: " + LogSafe.truncate(e.message))
        }
        if (!result.ok) {
            return actionFailure(result.reason ?: "type failed", result.error, kernel.lastKnownUrl, lookup.tabId)
        }
        val verdict = if (result.found == true) {
            buildJsonObject {
                put("found", true)
                put("typed", result.typed ?: text.length)
            }
        } else {
            buildJsonObject {
                put("found", false)
                put("reason", result.reason ?: "element not found")
            }
        }
        return finishWithSnapshot(kernel, kernel.state.name, tab = lookup.tabId, actionFields = verdict)
    }

    /** 057 EVALUATE: run the user's JS in the page; the completion value comes back as a string. */
    private fun evaluate(project: Project, request: AgentBrowserRequest): JsonObject {
        val lookup = resolveAgentPanel(project, request)
        val panel = lookup.panel ?: return failure(lookup.missReason ?: NO_TAB_REASON)
        val kernel = panel.agentKernel()
        val js = request.js ?: return failure("action evaluate requires js", tab = lookup.tabId)
        val result = try {
            kernel.evaluateJs(js).get(LOAD_WAIT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            ActionResult.failure("evaluate did not return: " + LogSafe.truncate(e.message))
        }
        if (!result.ok) {
            return actionFailure(result.reason ?: "evaluate failed", result.error, kernel.lastKnownUrl, lookup.tabId)
        }
        return finishWithSnapshot(
            kernel,
            kernel.state.name,
            tab = lookup.tabId,
            actionFields = buildJsonObject { put("value", result.value ?: "") },
        )
    }

    /**
     * 057: failure answer for an action whose round-trip died (no page,
     * timeout, in-flight, page-side throw). The page-side error rides as the
     * `error` field when the page named one; no snapshot — the channel the
     * snapshot would ride is the one that failed (scroll precedent).
     */
    internal fun actionFailure(reason: String, error: String?, url: String, tab: String?): JsonObject =
        buildJsonObject {
            put("ok", false)
            put("reason", reason)
            error?.let { put("error", it) }
            if (url.isNotBlank()) put("url", url)
            if (tab != null) put("tab", tab)
        }

    private fun finishWithSnapshot(
        kernel: PiBrowserKernel,
        state: String,
        autoDetected: Boolean = false,
        candidates: List<Int> = emptyList(),
        scrollY: Int? = null,
        selector: String? = null,
        format: String? = null,
        tab: String? = null,
        actionFields: JsonObject? = null,
    ): JsonObject {
        val snapshot = try {
            kernel.readPage(selector = selector, format = format)
                .get(PageSnapshotSanitizer.MAX_TEXT_CHARS.toLong() + 5_000L, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            PageSnapshot.failure("read did not return: " + LogSafe.truncate(e.message), kernel.lastKnownUrl)
        }
        // F-206: the page's recent console errors ride along on every answer —
        // success or failure — so the model sees WHY a page misbehaves instead
        // of guessing from an empty text excerpt. Bounded by the buffer itself.
        val console = kernel.recentConsoleLines(5)
        return snapshotResponse(
            ok = snapshot.ok,
            reason = snapshot.reason,
            state = state,
            url = snapshot.url,
            title = snapshot.title,
            ready = snapshot.readyState,
            text = snapshot.text,
            console = console,
            autoDetected = autoDetected,
            candidates = candidates,
            scrollY = scrollY,
            selector = selector,
            tab = tab,
            actionFields = actionFields,
        )
    }

    /**
     * The pure response assembly behind every snapshot answer (unit-tested):
     * the 049 field order is untouched when the 053 extras are absent —
     * scrollY inserts after text, selector echoes after url when present.
     * 056 adds `tab` (the addressed panel's id) at the very TAIL — the field
     * order before it stays byte-locked by the 049/053/055 assertions.
     * 057 adds [actionFields] (the click/type/evaluate verdict, flattened —
     * found/tag/elementText/typed/value/reason) between console and tab.
     */
    internal fun snapshotResponse(
        ok: Boolean,
        reason: String?,
        state: String,
        url: String,
        title: String,
        ready: String,
        text: String,
        console: List<String>,
        autoDetected: Boolean,
        candidates: List<Int>,
        scrollY: Int?,
        selector: String? = null,
        tab: String? = null,
        actionFields: JsonObject? = null,
    ): JsonObject = buildJsonObject {
        if (!ok) {
            put("ok", false)
            put("reason", reason ?: "page snapshot failed")
            put("state", state)
            put("url", url)
            if (selector != null) put("selector", selector)
            if (scrollY != null) put("scrollY", scrollY)
            appendConsole(console)
            actionFields?.forEach { (key, value) -> put(key, value) }
            if (tab != null) put("tab", tab)
        } else {
            put("ok", true)
            put("state", state)
            put("url", url)
            if (selector != null) put("selector", selector)
            put("title", title)
            put("ready", ready)
            put("text", text)
            if (scrollY != null) put("scrollY", scrollY)
            if (autoDetected) {
                put("detected", true)
                put("candidates", buildJsonArray { candidates.forEach { add(it) } })
            }
            appendConsole(console)
            actionFields?.forEach { (key, value) -> put(key, value) }
            if (tab != null) put("tab", tab)
        }
    }

    /**
     * The pure console response assembly (unit-tested): ok stays true for an
     * empty buffer (zero captured errors IS the answer for a verification
     * call), with a reason field explaining what is and is not captured.
     * 056: the addressed panel's id rides at the tail.
     */
    internal fun consoleResponse(window: ConsoleWindow, since: Int, file: String?, tab: String? = null): JsonObject {
        val lines = window.entries.map { "[${it.index}] ${it.text}" }
        return buildJsonObject {
            put("ok", true)
            put("total", window.total)
            put("dropped", window.dropped)
            put("count", window.matched)
            if (lines.isEmpty()) {
                put(
                    "reason",
                    if (window.total == 0) CONSOLE_EMPTY_REASON
                    else "no new lines after index $since (total is ${window.total}); the buffer was cleared by a navigation or since is ahead of the captured lines — lower since",
                )
            }
            put("lines", buildJsonArray { lines.forEach { add(it) } })
            if (file != null) put("file", file)
            if (tab != null) put("tab", tab)
        }
    }

    /**
     * 056: the pure LIST assembly (unit-tested) — `{ok, tabs:[...]}` with the
     * per-tab wire order tab/url/title/carrier/selected.
     */
    internal fun listResponse(tabs: List<BrowserTabSummary>): JsonObject = buildJsonObject {
        put("ok", true)
        put("tabs", buildJsonArray {
            tabs.forEach { t ->
                add(buildJsonObject {
                    put("tab", t.tabId)
                    put("url", t.url)
                    put("title", t.title)
                    put("carrier", t.carrier)
                    put("selected", t.selected)
                })
            }
        })
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

    private fun failure(reason: String, url: String = "", tab: String? = null): JsonObject = buildJsonObject {
        put("ok", false)
        put("reason", reason)
        if (url.isNotBlank()) put("url", url)
        if (tab != null) put("tab", tab)
    }
}
