package dev.pi.agent.browser

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import dev.pi.agent.PiAgentBundle
import dev.pi.agent.settings.PiAgentSettings
import java.lang.reflect.Proxy
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.cef.browser.CefBrowser
import javax.swing.JComponent

/**
 * The browser tab's engine (spec 048 T008): a lazy windowed [JBCefBrowser]
 * plus the probe-verified handler set ([PiBrowserHandlers]), a small state
 * machine ([PiBrowserState]) and crash rebuild with a storm fuse.
 *
 * Carriers (tool window content, editor panel — spec 048 D7/D12) own a kernel
 * each and only render `component()`; the kernel never touches Swing layout
 * beyond that single component, so it stays carrier-agnostic.
 *
 * Hard rules baked in (plan §0 probe evidence):
 *  - exactly ONE windowed browser per kernel — native HWNDs drift and cover
 *    Swing siblings (P-7), so no second instance ever gets created here;
 *  - the only JS bridge is the agent's READ-ONLY page snapshot (049 D4) —
 *    no tokens, nothing from BridgeService;
 *  - crash detection via `onRenderProcessTerminated` — `JBCefHealthMonitor`
 *    does not exist on the 233–263 line (P-6);
 *  - after navigation the frame is force-repainted (P-9 stale-frame residue).
 */
class PiBrowserKernel(
    private val project: Project,
    parent: Disposable,
    /**
     * P-7 (round-2 enforcement): OSR kernels don't own a native HWND, so the
     * multi-tab manager may run tabs 2+ offscreen without stacking hidden
     * native windows over the visible page. Default windowed (048 D2).
     */
    private val offscreen: Boolean = false,
) : Disposable {

    private val log = Logger.getInstance(PiBrowserKernel::class.java)

    init {
        // One registration covers the whole kernel; carriers must NOT
        // Disposer.register the kernel again (double dispose).
        Disposer.register(parent, this)
    }

    private var browser: JBCefBrowser? = null
    private var handlers: PiBrowserHandlers? = null

    /**
     * 049 robustness: set when the kernel itself is disposed. After that
     * every platform call is a no-op — the browser is gone and the platform's
     * remote wrapper may throw on any navigation-state query.
     */
    @Volatile
    private var disposed = false

    /**
     * 049 D4: the page→IDE readback channel, created once per browser (a
     * JBCefJSQuery is client-level infrastructure; creating one per read
     * would churn routers and log pool warnings).
     */
    private var jsQuery: JBCefJSQuery? = null

    /** F-206/F-207 round 2: the per-query statement that ships a page-side
     *  tapEvent variable back to [onReadResult]; built once with the query. */
    private var tapScript: String? = null

    /** 049 readPage: the one in-flight snapshot request, or null. */
    private var pendingRead: CompletableFuture<PageSnapshot>? = null

    /** F-206: bounded page console errors, cleared on every navigate. */
    private val consoleBuffer = BrowserConsoleBuffer()

    private val listeners = java.util.concurrent.CopyOnWriteArrayList<(PiBrowserState) -> Unit>()

    @Volatile
    var state: PiBrowserState = PiBrowserState.IDLE
        private set

    /** Callback target for the address echo; receives the RAW URL (F-103). */
    @Volatile
    var onAddressChanged: ((String) -> Unit)? = null

    /** Callback target for title echo; receives the scrubbed title. */
    @Volatile
    var onTitleChanged: ((String) -> Unit)? = null

    /** F-201: raw URL of every committed navigation, for the project history. */
    @Volatile
    var onNavigationHistory: ((String) -> Unit)? = null

    /** Callback for download completion (success, display path). EDT-safe. */
    @Volatile
    var onDownloadFinished: ((Boolean, String) -> Unit)? = null

    /** F-213: download progress for the carrier's echo row (name, received, total). */
    @Volatile
    var onDownloadProgress: ((String, Long, Long) -> Unit)? = null

    /** F-102: authoritative canGoBack/canGoForward from CEF's loading-state flips. */
    @Volatile
    var onNavStateChanged: ((Boolean, Boolean) -> Unit)? = null

    /** F-210: main-frame load failure details for the error card. */
    @Volatile
    var onLoadError: ((errorCode: String, errorText: String) -> Unit)? = null

    /** F-215 M1: a popup interception ended in ASK — carrier shows the selector. */
    @Volatile
    var onAskPopup: ((String) -> Unit)? = null

    /** F-204: Ctrl+F inside the page → carrier toggles its find bar. */
    @Volatile
    var onFindRequest: (() -> Unit)? = null

    /** F-204: Esc while the find bar is open → carrier closes it. */
    @Volatile
    var onFindClose: (() -> Unit)? = null

    /** F-204: the carrier answers synchronously whether its find bar is open. */
    @Volatile
    var isFindBarOpen: () -> Boolean = { false }

    /** 043 replaces this; P0 ships strict-only. */
    @Volatile
    var certPolicy: PiCertPolicy = StrictCertPolicy

    /** Last tracked address (RAW, F-103) — agent readback and open-external reuse it. */
    @Volatile
    var lastKnownUrl: String = ""
        private set

    /** Last tracked page title (scrubbed). */
    @Volatile
    var lastKnownTitle: String = ""
        private set

    /** F-202③: set by [stop]; the next main-frame LoadError keeps the partial page. */
    @Volatile
    private var stopRequested = false

    /** Set once the fuse blew: rebuilds stop until a carrier force-reloads. */
    @Volatile
    var rebuildGaveUp: Boolean = false
        private set

    private val rebuildStamps = ArrayDeque<Long>()

    /** Lazily creates the browser. Returns null when JCEF is unavailable. Call on EDT. */
    private fun ensureCreated(): JBCefBrowser? {
        if (disposed) return null
        browser?.let { return it }
        if (!JBCefApp.isSupported()) {
            log.warn("browser tab: JCEF not supported")
            return null
        }
        return createOnEdt()
    }

    private fun createOnEdt(): JBCefBrowser {
        // 052: creating a browser freezes the JCEF log level — ask for the
        // level that makes GPU crashes readable first.
        JcefLogLevelGuard.ensure()
        // F-209: the platform's own "Open DevTools" context-menu entry (public
        // builder flag, 233–263) — zero self-drawn menu work for inspect.
        val builder = JBCefBrowser.createBuilder()
            .setEnableOpenDevToolsMenuItem(true)
        if (offscreen) builder.setOffScreenRendering(true)
        val created = builder.build()
        val h = PiBrowserHandlers(this)
        browser = created
        handlers = h
        val client = created.jbCefClient
        val cef = created.cefBrowser
        client.addLifeSpanHandler(h.lifeSpanHandler, cef)
        client.addDownloadHandler(h.downloadHandler, cef)
        client.addRequestHandler(h.requestHandler, cef)
        client.addLoadHandler(h.loadHandler, cef)
        client.addDisplayHandler(h.displayHandler, cef)
        client.addFocusHandler(h.focusHandler, cef)
        client.addKeyboardHandler(h.keyboardHandler, cef)
        client.addContextMenuHandler(h.contextMenuHandler, cef)
        client.addJSDialogHandler(h.jsDialogHandler, cef)
        jsQuery = createReadbackQuery(created)
        log.info("browser kernel: " + (if (offscreen) "OSR" else "windowed") + " browser created")
        return created
    }

    /**
     * 049 robustness: the single funnel for platform browser calls. A dead
     * browser (disposed kernel, torn-down renderer, or the startup window
     * where the remote browser has not published its navigation state yet)
     * yields [default] instead of throwing — the platform's RemoteBrowser
     * unboxes a null Boolean on canGoBack() in exactly that window, and the
     * escaping NPE surfaced as an "IDE Internal Errors" balloon.
     */
    private fun <T> safe(what: String, default: T, block: (CefBrowser) -> T): T {
        if (disposed) return default
        val cef = browser?.cefBrowser ?: return default
        return BrowserSafety.guard(what, default, { msg -> log.warn(msg) }) { block(cef) }
    }

    /** Same funnel for calls that live on the [JBCefBrowser] facade itself. */
    private fun <T> safeFacade(what: String, default: T, block: (JBCefBrowser) -> T): T {
        if (disposed) return default
        val b = browser ?: return default
        return BrowserSafety.guard(what, default, { msg -> log.warn(msg) }) { block(b) }
    }

    /** The Swing component hosting the browser; null until created. */
    fun component(): JComponent? = browser?.component

    internal fun currentJbBrowser(): JBCefBrowser? = browser

    internal fun hopEdt(block: () -> Unit) {
        ApplicationManager.getApplication().invokeLater(block)
    }

    fun load(url: String) {
        if (!ApplicationManager.getApplication().isDispatchThread) {
            // Popup continuation arrives on a CEF thread; everything below
            // (lazy create, listener fire) is EDT discipline.
            ApplicationManager.getApplication().invokeLater { load(url) }
            return
        }
        val b = ensureCreated()
        if (b == null) {
            // Navigate first so the FAILED transition is legal (IDLE swallows
            // LoadError); the carrier shows the no-JCEF error card.
            onEvent(PiBrowserEvent.Navigate(url))
            onEvent(PiBrowserEvent.LoadError("NO_JCEF", "JCEF unavailable"))
            return
        }
        onEvent(PiBrowserEvent.Navigate(url))
        safe("loadURL", Unit) { it.loadURL(url) }
    }

    fun reload() {
        if (!safe("reload", false) { it.reload(); true }) return
        onEvent(PiBrowserEvent.Navigate(currentUrlOrNull() ?: ""))
    }

    /**
     * F-202③/F-203②: stop the in-flight load. stopLoad surfaces ERR_ABORTED
     * (filtered in the handlers), but some aborts land as other error codes —
     * [stopRequested] converts ANY main-frame LoadError until the next
     * Navigate into a LoadEnd, so the partial page survives and the carrier
     * never swaps it for the FAILED card (F-102 root cause 2 without the
     * 049-era goBack juggling).
     */
    fun stop() {
        if (browser == null) return
        stopRequested = true
        safe("stopLoad", Unit) { it.stopLoad() }
        if (state == PiBrowserState.LOADING) onEvent(PiBrowserEvent.LoadEnd)
    }

    fun back() {
        safe("goBack", Unit) { it.goBack() }
    }

    fun forward() {
        safe("goForward", Unit) { it.goForward() }
    }

    fun canGoBack(): Boolean = safe("canGoBack", false) { it.canGoBack() }

    fun canGoForward(): Boolean = safe("canGoForward", false) { it.canGoForward() }

    /** F-209: opens the platform DevTools window for the current page. */
    fun openDevtools() {
        safeFacade("openDevtools", Unit) { it.openDevtools() }
    }

    // ---- F-204: page find ----

    fun find(searchText: String, forward: Boolean, matchCase: Boolean, findNext: Boolean) {
        safe("find", Unit) { it.find(searchText, forward, matchCase, findNext) }
    }

    fun stopFinding(clearSelection: Boolean = true) {
        safe("stopFinding", Unit) { it.stopFinding(clearSelection) }
    }

    /** RAW current URL (F-103); empty string before the first load. */
    fun currentUrl(): String = currentUrlOrNull() ?: ""

    private fun currentUrlOrNull(): String? = safe("getURL", null) { it.getURL() }

    // ---- CEF -> state plumbing (called from CEF threads) ----

    internal fun onEvent(event: PiBrowserEvent) {
        // F-202③: a user-requested stop must keep the half-loaded page — any
        // main-frame LoadError until the next Navigate becomes a plain LoadEnd.
        val effective = if (event is PiBrowserEvent.LoadError && stopRequested) {
            stopRequested = false
            log.debug("browser state: stopRequested swallowed LoadError " + event.errorCode)
            PiBrowserEvent.LoadEnd
        } else {
            if (event is PiBrowserEvent.Navigate) stopRequested = false // next navigation owns the flag again
            event
        }
        if (effective is PiBrowserEvent.Navigate) {
            consoleBuffer.clear() // F-206: console lines describe ONE page
        }
        val old: PiBrowserState
        val next: PiBrowserState?
        synchronized(stateLock) {
            old = state
            next = PiBrowserStateMachine.transition(state, effective)
            if (next != null) state = next
        }
        if (next == null) {
            log.debug("browser state: dropped " + effective::class.simpleName + " in " + old)
            return
        }
        if (effective is PiBrowserEvent.LoadEnd) {
            JcefFrameRepaint.forceRepaint(browser)
            injectTap() // F-206/F-207: console+dialog shim rides every document
        }
        if (effective is PiBrowserEvent.LoadError) {
            // F-210: the state machine folds the payload away; the side-channel
            // (queued BEFORE fireState) hands it to the carrier's error card.
            ApplicationManager.getApplication().invokeLater {
                onLoadError?.invoke(effective.errorCode, effective.errorText)
            }
        }
        when {
            next == PiBrowserState.CRASHED && old != PiBrowserState.CRASHED -> scheduleRebuild()
        }
        fireState(next)
    }

    internal fun onAddressChanged(raw: String) {
        lastKnownUrl = raw
        ApplicationManager.getApplication().invokeLater { onAddressChanged?.invoke(raw) }
    }

    internal fun onTitleChanged(scrubbed: String) {
        if (scrubbed.isNotBlank()) lastKnownTitle = scrubbed
        ApplicationManager.getApplication().invokeLater { onTitleChanged?.invoke(scrubbed) }
    }

    internal fun feedNavigationHistory(raw: String) {
        ApplicationManager.getApplication().invokeLater { onNavigationHistory?.invoke(raw) }
    }

    internal fun onNavStateChanged(canGoBack: Boolean, canGoForward: Boolean) {
        ApplicationManager.getApplication().invokeLater { onNavStateChanged?.invoke(canGoBack, canGoForward) }
    }

    /**
     * F-215 M1: popups route through the same three-state decision as chat
     * links. Loopback stays in place (048 US5 byte-for-byte), SYSTEM hands off
     * to the system browser, EMBEDDED continues in this tab, ASK delegates to
     * the carrier's selector popup ([onAskPopup]).
     */
    internal fun continuePopupInPlace(targetUrl: String) {
        val decision = LinkRouting.routeExternalLink(targetUrl, PiAgentSettings.getInstance().linkTarget(), ownOrigin = null)
        log.info("browser popup intercepted: " + LogSafe.url(targetUrl) + " -> " + decision::class.simpleName)
        when (decision) {
            is LinkRoute.CefDefault -> {
                if (targetUrl.isBlank()) return // cancel only; never navigate a blank (US5)
                load(targetUrl)
            }
            is LinkRoute.Embedded -> load(targetUrl)
            is LinkRoute.SystemBrowser -> BrowserUtil.browse(targetUrl)
            is LinkRoute.AskUser -> {
                val ask = onAskPopup
                if (ask != null) ApplicationManager.getApplication().invokeLater { ask(targetUrl) }
                else BrowserUtil.browse(targetUrl)
            }
        }
    }

    // ---- downloads ----

    /** F-110 round 2: a download-shaped navigation was cancelled at browse level; fetch IDE-side. */
    internal fun onDownloadUrlRequested(url: String) {
        PiDownloader.downloadUrl(project, url)
    }

    /** F-110: a download-carrying navigation never fires LoadEnd (OOP/144); clear LOADING here. */
    internal fun onDownloadStarted() {
        if (state == PiBrowserState.LOADING) onEvent(PiBrowserEvent.LoadEnd)
    }

    internal fun onDownloadProgress(name: String, received: Long, total: Long) {
        ApplicationManager.getApplication().invokeLater { onDownloadProgress?.invoke(name, received, total) }
    }

    internal fun onDownloadFinished(success: Boolean, path: String) {
        ApplicationManager.getApplication().invokeLater {
            onDownloadFinished?.invoke(success, path)
            if (success) {
                // F-213 体验点: the done notification's action opens the folder.
                PiDownloader.notifyDone(project, path)
            } else {
                NotificationGroupManager.getInstance()
                    .getNotificationGroup(NOTIFICATION_GROUP)
                    .createNotification(
                        PiAgentBundle.message("browser.download.failed", LogSafe.truncate(path, 120)),
                        NotificationType.ERROR,
                    )
                    .notify(project)
            }
        }
    }

    // ---- agent readback (049 D4; spec §五 rule 1 revision: read-only, no tokens) ----

    /**
     * Read-only snapshot of the current page for the agent tool
     * (spec 049 US4). The only JS injection the browser tab ever performs;
     * bounded by the script itself (3000 chars) plus [timeoutMs] so a hung or
     * CSP-locked page degrades to a failure snapshot instead of hanging the
     * agent tool call. Returns immediately with a failure snapshot when there
     * is no live page to read.
     */
    fun readPage(timeoutMs: Long = DEFAULT_READ_TIMEOUT_MS): CompletableFuture<PageSnapshot> {
        val url = lastKnownUrl
        val b = browser
        if (b == null) {
            return CompletableFuture.completedFuture(PageSnapshot.failure("browser tab is not open", url))
        }
        if (state == PiBrowserState.CRASHED) {
            return CompletableFuture.completedFuture(PageSnapshot.failure("browser renderer is down", url))
        }
        val query = jsQuery
        if (query == null) {
            return CompletableFuture.completedFuture(PageSnapshot.failure("browser is still starting", url))
        }
        synchronized(this) {
            if (pendingRead != null) {
                return CompletableFuture.completedFuture(
                    PageSnapshot.failure("another read is still in flight; retry shortly", url),
                )
            }
            val future = CompletableFuture<PageSnapshot>()
                .completeOnTimeout(
                    PageSnapshot.failure("read timed out; the page may still be loading or blocked", url),
                    timeoutMs, TimeUnit.MILLISECONDS,
                )
            pendingRead = future
            val script = PageSnapshotSanitizer.buildReadScript(query.inject("result"))
            var failure: String? = null
            BrowserSafety.guard("executeJavaScript", Unit, { msg -> failure = msg }) {
                b.cefBrowser.executeJavaScript(script, null, 0)
            }
            if (failure != null) {
                pendingRead = null
                future.complete(PageSnapshot.failure("injection failed: " + LogSafe.truncate(failure), url))
            }
            return future
        }
    }

    /** Recent page console errors for the agent snapshot (F-206); empty when capture is unavailable. */
    fun recentConsoleLines(limit: Int = 5): List<String> = consoleBuffer.recent(limit)

    /**
     * CEF message-router callback (CEF browser-process thread). Routes three
     * shapes over ONE query: page snapshots (the F-206 original path), console
     * taps and JS dialog shims (round-2 replacements for the reflection
     * devToolsClient mount and the CefJSDialogHandler that never fire on the
     * remote/CEF-144 channel).
     */
    private fun onReadResult(request: String?): JBCefJSQuery.Response {
        val req = request ?: return JBCefJSQuery.Response(null)
        when {
            req.contains("\"kind\":\"console\"") -> {
                runCatching {
                    val obj = Json.parseToJsonElement(req).jsonObject
                    consoleBuffer.onTapLine(
                        obj["level"]?.jsonPrimitive?.content ?: "error",
                        obj["text"]?.jsonPrimitive?.content ?: "",
                    )
                }
            }
            req.contains("\"kind\":\"dialog\"") -> {
                runCatching {
                    val obj = Json.parseToJsonElement(req).jsonObject
                    val type = obj["type"]?.jsonPrimitive?.content ?: "alert"
                    val text = obj["text"]?.jsonPrimitive?.content ?: ""
                    hopEdt { showJsDialog(type, text) }
                }
            }
            else -> {
                val future = pendingRead
                if (future != null) {
                    val snapshot = PageSnapshotSanitizer.fromJs(req, lastKnownUrl, lastKnownTitle)
                    future.complete(snapshot)
                    pendingRead = null
                }
            }
        }
        return JBCefJSQuery.Response(null)
    }

    /**
     * F-207 round 2: page alert/confirm/prompt become VISIBLE (notification),
     * replacing the silently-auto-dismissed default. confirm/prompt answer
     * false/null immediately - the page proceeds with the safe default while
     * the notification explains why.
     */
    private fun showJsDialog(type: String, text: String) {
        val shown = LogSafe.truncate(text.ifBlank { "(empty message)" }, 160)
        val (message, isWarning) = when (type) {
            "confirm" -> PiAgentBundle.message("browser.jsdialog.confirm", shown) to true
            "prompt" -> PiAgentBundle.message("browser.jsdialog.prompt", shown) to true
            else -> PiAgentBundle.message("browser.jsdialog.alert", shown) to false
        }
        NotificationGroupManager.getInstance()
            .getNotificationGroup("Pi Agent")
            .createNotification(message, if (isWarning) NotificationType.WARNING else NotificationType.INFORMATION)
            .notify(project)
    }

    private fun createReadbackQuery(browser: JBCefBrowser): JBCefJSQuery {
        val query = JBCefJSQuery.create(browser)
        query.addHandler { request -> onReadResult(request) }
        // Kernel dispose drops the query; the client-side registration dies with the client.
        Disposer.register(this, query)
        tapScript = query.inject("tapEvent")
        return query
    }

    /**
     * F-206/F-207 round 2: inject the console/dialog tap through the SAME
     * channel the page readback uses (JBCefJSQuery - verified working on the
     * remote/CEF-144 machine, unlike the reflection devToolsClient mount and
     * the CefJSDialogHandler that the thrift channel silently drops).
     *
     * The tap captures console.error/warning into a page buffer AND ships
     * them back; it also overrides alert/confirm/prompt so page dialogs
     * become visible notifications (confirm/prompt answer the safe default
     * immediately - the notification explains it). Idempotent per document;
     * re-injected on every LoadEnd.
     */
    private fun injectTap() {
        val inject = tapScript ?: return
        val b = browser ?: return
        BrowserSafety.guard("tap inject", Unit, { msg -> log.debug(msg) }) {
            b.cefBrowser.executeJavaScript(PageSnapshotSanitizer.buildTapScript(inject), null, 0)
        }
    }

    fun addStateListener(listener: (PiBrowserState) -> Unit) {
        listeners.add(listener)
        listener(state)
    }

    fun removeStateListener(listener: (PiBrowserState) -> Unit) {
        listeners.remove(listener)
    }

    private fun fireState(next: PiBrowserState) {
        ApplicationManager.getApplication().invokeLater {
            for (l in listeners) l(next)
        }
    }

    // ---- crash rebuild with storm fuse (chat-panel pattern, new trigger) ----

    private fun scheduleRebuild() {
        ApplicationManager.getApplication().invokeLater {
            if (rebuildGaveUp) return@invokeLater
            val now = System.currentTimeMillis()
            val attempts = synchronized(rebuildStamps) {
                while (rebuildStamps.isNotEmpty() && now - rebuildStamps.first() > REBUILD_WINDOW_MS) {
                    rebuildStamps.removeFirst()
                }
                rebuildStamps.addLast(now)
                rebuildStamps.size
            }
            if (attempts > MAX_REBUILDS_PER_WINDOW) {
                log.warn("browser keeps crashing; not rebuilding again ($attempts in window)")
                rebuildGaveUp = true
                fireState(PiBrowserState.CRASHED) // carrier shows the permanent card
                return@invokeLater
            }
            log.info("browser kernel: rebuilding renderer ($attempts)")
            disposeBrowser()
            onEvent(PiBrowserEvent.Rebuilt)
        }
    }

    /**
     * Carrier "Retry" action on a crash card: clears the fuse and reloads.
     *
     * 051: the card's Retry button now shows even when the browser never
     * reported an address, so the URL can be blank. Navigating to an empty
     * URL would only produce another load error, so the renderer is rebuilt
     * and left idle instead — the user gets a working browser back, ready
     * for the next address.
     */
    fun manualReload(url: String) {
        rebuildGaveUp = false
        synchronized(rebuildStamps) { rebuildStamps.clear() }
        onEvent(PiBrowserEvent.Rebuilt)
        val target = url.ifBlank { lastKnownUrl }
        if (target.isBlank()) {
            log.info("browser kernel: manual reload without a known address; renderer rebuilt and left idle")
            return
        }
        load(target)
    }

    private fun disposeBrowser() {
        val current = browser ?: return
        val h = handlers
        browser = null
        handlers = null
        runCatching { pendingRead?.complete(PageSnapshot.failure("browser closed during read", lastKnownUrl)) }
        pendingRead = null
        runCatching { jsQuery?.dispose() }
        jsQuery = null
        consoleBuffer.clear()
        runCatching {
            val client = current.jbCefClient
            val cef = current.cefBrowser
            if (h != null) {
                client.removeLifeSpanHandler(h.lifeSpanHandler, cef)
                client.removeDownloadHandle(h.downloadHandler, cef)
                client.removeRequestHandler(h.requestHandler, cef)
                client.removeLoadHandler(h.loadHandler, cef)
                client.removeDisplayHandler(h.displayHandler, cef)
                client.removeFocusHandler(h.focusHandler, cef)
                client.removeKeyboardHandler(h.keyboardHandler, cef)
                client.removeContextMenuHandler(h.contextMenuHandler, cef)
                client.removeJSDialogHandler(h.jsDialogHandler, cef)
            }
        }
        runCatching { current.dispose() }
    }

    override fun dispose() {
        disposed = true
        disposeBrowser()
        listeners.clear()
        // Drop the carrier's callbacks: a carrier that outlived the kernel
        // must not keep invoking into a dead browser.
        onAddressChanged = null
        onTitleChanged = null
        onNavigationHistory = null
        onDownloadFinished = null
        onDownloadProgress = null
        onNavStateChanged = null
        onLoadError = null
        onAskPopup = null
        onFindRequest = null
        onFindClose = null
        isFindBarOpen = { false }
    }

    private val stateLock = Any()

    private companion object {
        const val NOTIFICATION_GROUP = "Pi Agent"
        const val REBUILD_WINDOW_MS = 60_000L
        const val MAX_REBUILDS_PER_WINDOW = 2

        /** Hard ceiling for one page read (spec 049 hard rule 9). */
        const val DEFAULT_READ_TIMEOUT_MS = 10_000L
    }
}
