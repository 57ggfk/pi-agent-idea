package dev.pi.agent.browser

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
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
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
 *  - no bridge involvement: no JSQuery, no token, nothing from BridgeService;
 *  - crash detection via `onRenderProcessTerminated` — `JBCefHealthMonitor`
 *    does not exist on the 233–263 line (P-6);
 *  - after navigation the frame is force-repainted (P-9 stale-frame residue).
 */
class PiBrowserKernel(
    private val project: Project,
    parent: Disposable,
    /** Editor carrier uses OSR: only ONE windowed browser may exist (P-7). */
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
     * 049 D4: the page→IDE readback channel, created once per browser (a
     * JBCefJSQuery is client-level infrastructure; creating one per read
     * would churn routers and log pool warnings).
     */
    private var jsQuery: JBCefJSQuery? = null

    /** 049 readPage: the one in-flight snapshot request, or null. */
    private var pendingRead: CompletableFuture<PageSnapshot>? = null

    private val listeners = java.util.concurrent.CopyOnWriteArrayList<(PiBrowserState) -> Unit>()

    @Volatile
    var state: PiBrowserState = PiBrowserState.IDLE
        private set

    /** Callback target for address echo; receives the scrubbed URL. */
    @Volatile
    var onAddressChanged: ((String) -> Unit)? = null

    /** Callback target for title echo; receives the scrubbed title. */
    @Volatile
    var onTitleChanged: ((String) -> Unit)? = null

    /** Callback for download completion (success, display path). EDT-safe. */
    @Volatile
    var onDownloadFinished: ((Boolean, String) -> Unit)? = null

    /**
     * 049: right-click on a link inside the loaded web page (context-menu
     * handler in [PiBrowserHandlers]). Receives the absolute link URL; the
     * carrier shows the destination selector. EDT-safe (hopped below).
     */
    @Volatile
    var onLinkContextMenu: ((String) -> Unit)? = null

    /** 043 replaces this; P0 ships strict-only. */
    @Volatile
    var certPolicy: PiCertPolicy = StrictCertPolicy

    /** Last echoed address (scrubbed) — agent readback reuses the toolbar echo as one source of truth. */
    @Volatile
    var lastKnownUrl: String = ""
        private set

    /** Last echoed page title. */
    @Volatile
    var lastKnownTitle: String = ""
        private set

    /** Set once the fuse blew: rebuilds stop until a carrier force-reloads. */
    @Volatile
    var rebuildGaveUp: Boolean = false
        private set

    private val rebuildStamps = ArrayDeque<Long>()

    /** Lazily creates the browser. Returns null when JCEF is unavailable. Call on EDT. */
    private fun ensureCreated(): JBCefBrowser? {
        browser?.let { return it }
        if (!JBCefApp.isSupported()) {
            log.warn("browser tab: JCEF not supported")
            return null
        }
        return createOnEdt()
    }

    private fun createOnEdt(): JBCefBrowser {
        val created = if (offscreen) {
            JBCefBrowser.createBuilder().setOffScreenRendering(true).build()
        } else {
            JBCefBrowser()
        }
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
        client.addContextMenuHandler(h.contextMenuHandler, cef)
        jsQuery = createReadbackQuery(created)
        log.info("browser kernel: " + (if (offscreen) "OSR" else "windowed") + " browser created")
        return created
    }

    /** The Swing component hosting the browser; null until created. */
    fun component(): JComponent? = browser?.component

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
        b.cefBrowser.loadURL(url)
    }

    fun reload() {
        browser?.cefBrowser?.reload() ?: return
        onEvent(PiBrowserEvent.Navigate(currentUrlOrNull() ?: ""))
    }

    /**
     * 049: stop the in-flight load. CEF will surface ERR_ABORTED (ignored by
     * the state machine), so fire LoadEnd explicitly — the carrier drops the
     * LOADING hint and the partial page stays visible.
     */
    fun stop() {
        val b = browser ?: return
        b.cefBrowser.stopLoad()
        onEvent(PiBrowserEvent.LoadEnd)
    }

    fun back() {
        browser?.cefBrowser?.goBack()
    }

    fun forward() {
        browser?.cefBrowser?.goForward()
    }

    fun canGoBack(): Boolean = browser?.cefBrowser?.canGoBack() ?: false

    fun canGoForward(): Boolean = browser?.cefBrowser?.canGoForward() ?: false

    fun currentUrl(): String = LogSafe.url(currentUrlOrNull())

    private fun currentUrlOrNull(): String? = try {
        browser?.cefBrowser?.getURL()
    } catch (_: Throwable) {
        null
    }

    // ---- CEF -> state plumbing (called from CEF threads) ----

    internal fun onEvent(event: PiBrowserEvent) {
        val old: PiBrowserState
        val next: PiBrowserState?
        synchronized(stateLock) {
            old = state
            next = PiBrowserStateMachine.transition(state, event)
            if (next != null) state = next
        }
        if (next == null) {
            log.debug("browser state: dropped " + event::class.simpleName + " in " + old)
            return
        }
        if (event is PiBrowserEvent.LoadEnd) {
            JcefFrameRepaint.forceRepaint(browser)
        }
        when {
            next == PiBrowserState.CRASHED && old != PiBrowserState.CRASHED -> scheduleRebuild()
        }
        fireState(next)
    }

    internal fun onAddressChanged(scrubbed: String) {
        lastKnownUrl = scrubbed
        ApplicationManager.getApplication().invokeLater { onAddressChanged?.invoke(scrubbed) }
    }

    internal fun onTitleChanged(scrubbed: String) {
        if (scrubbed.isNotBlank()) lastKnownTitle = scrubbed
        ApplicationManager.getApplication().invokeLater { onTitleChanged?.invoke(scrubbed) }
    }

    /** CEF context-menu thread → EDT hop for the page-link selector. */
    internal fun onLinkContextMenuArrived(url: String) {
        ApplicationManager.getApplication().invokeLater { onLinkContextMenu?.invoke(url) }
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
            try {
                b.cefBrowser.executeJavaScript(script, null, 0)
            } catch (e: Throwable) {
                pendingRead = null
                future.complete(PageSnapshot.failure("injection failed: " + LogSafe.truncate(e.message), url))
            }
            return future
        }
    }

    /** CEF message-router callback (CEF browser-process thread). */
    private fun onReadResult(request: String?): JBCefJSQuery.Response {
        val future = pendingRead
        if (future != null) {
            val snapshot = PageSnapshotSanitizer.fromJs(request, lastKnownUrl, lastKnownTitle)
            future.complete(snapshot)
            pendingRead = null
        }
        return JBCefJSQuery.Response(null)
    }

    private fun createReadbackQuery(browser: JBCefBrowser): JBCefJSQuery {
        val query = JBCefJSQuery.create(browser)
        query.addHandler { request -> onReadResult(request) }
        // Kernel dispose drops the query; the client-side registration dies with the client.
        Disposer.register(this, query)
        return query
    }

    internal fun continuePopupInPlace(targetUrl: String) {
        log.info("browser popup intercepted -> in-place: " + LogSafe.url(targetUrl))
        if (targetUrl.isBlank()) return // cancel only; never navigate a blank (US5)
        load(targetUrl)
    }

    internal fun onDownloadFinished(success: Boolean, path: String) {
        ApplicationManager.getApplication().invokeLater {
            onDownloadFinished?.invoke(success, path)
            val type = if (success) NotificationType.INFORMATION else NotificationType.ERROR
            val key = if (success) "browser.download.done" else "browser.download.failed"
            NotificationGroupManager.getInstance()
                .getNotificationGroup(NOTIFICATION_GROUP)
                .createNotification(
                    PiAgentBundle.message(key, LogSafe.truncate(path, 120)),
                    type,
                )
                .notify(project)
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

    /** Carrier "Reload" action on a permanent error card: clears the fuse. */
    fun manualReload(url: String) {
        rebuildGaveUp = false
        synchronized(rebuildStamps) { rebuildStamps.clear() }
        onEvent(PiBrowserEvent.Rebuilt)
        load(url)
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
                client.removeContextMenuHandler(h.contextMenuHandler, cef)
            }
        }
        runCatching { current.dispose() }
    }

    override fun dispose() {
        disposeBrowser()
        listeners.clear()
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
