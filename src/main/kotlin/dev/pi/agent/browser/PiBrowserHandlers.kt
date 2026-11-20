package dev.pi.agent.browser

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.Messages
import dev.pi.agent.PiAgentBundle
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefBeforeDownloadCallback
import org.cef.callback.CefContextMenuParams
import org.cef.callback.CefDownloadItem
import org.cef.callback.CefMenuModel
import org.cef.handler.CefContextMenuHandlerAdapter
import org.cef.handler.CefDisplayHandlerAdapter
import org.cef.handler.CefDownloadHandler
import org.cef.handler.CefFocusHandlerAdapter
import org.cef.handler.CefJSDialogHandler
import org.cef.handler.CefJSDialogHandlerAdapter
import org.cef.handler.CefKeyboardHandler
import org.cef.handler.CefKeyboardHandlerAdapter
import org.cef.handler.CefLifeSpanHandlerAdapter
import org.cef.handler.CefLoadHandler
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandler
import java.awt.datatransfer.StringSelection
import java.io.File
import java.lang.reflect.Proxy

/**
 * The browser tab's CEF handler set (spec 048 T007). Every non-obvious choice
 * here was verified on the real machine (probe P-1…P-12, plan §0) — do not
 * "simplify" without re-reading them:
 *
 *  - popups: `onBeforePopup` on the LIFESPAN handler is the only interception
 *    point (the request handler has no popup callback and `onOpenURLFromTab`
 *    does not receive target=_blank). Returning true cancels the popup; the
 *    kernel then routes the URL per the link-target setting (F-215 M1) —
 *    never a silent drop (spec 048 US5).
 *  - downloads: without a handler CEF cancels the download and the file
 *    vanishes; `Continue` MUST get a native-backslash path or the download
 *    silently stalls (P-4). The handler is a reflective Proxy (F-110): the
 *    compile baseline (ideaIC 243) declares `void onBeforeDownload` while
 *    IDEA 2026.2's JCEF 144 declares `boolean` — a plain anonymous object
 *    compiled against 243 throws NoSuchMethodError inside the CEF JNI
 *    boundary there, which silently cancels every download. The Proxy is
 *    built against the RUNTIME interface and answers per `method.returnType`.
 *  - certificates: strict by default — CEF shows its readable interstitial
 *    page, never a white screen (P-3). Policy relaxation is 043's job via
 *    [PiCertPolicy]; the CDP proceed path does not work.
 *  - the request handler is bridged through the same Proxy mechanism
 *    (F-110): 2026.2's `onRenderProcessTerminated` has 4 parameters
 *    (browser, status, int, String) vs 2 on 243 — same silent-dead failure.
 */
internal class PiBrowserHandlers(private val kernel: PiBrowserKernel) {

    private val log = Logger.getInstance(PiBrowserHandlers::class.java)

    // ---- navigation / popups (lifespan) ----

    val lifeSpanHandler = object : CefLifeSpanHandlerAdapter() {
        override fun onBeforePopup(browser: CefBrowser, frame: CefFrame?, targetUrl: String, targetFrameName: String?): Boolean {
            kernel.continuePopupInPlace(targetUrl)
            return true
        }
    }

    // ---- downloads (F-110 ABI bridge) ----

    /**
     * The kernel's download handler. The download logic itself is unchanged
     * from probe P-4; only the JNI-visible shape is now runtime-correct.
     * [onStart] fires on every accepted download so a download-only
     * navigation still leaves LOADING (the OOP/2026.2 case where LoadEnd
     * never arrives, F-110); [onProgress] feeds the carrier's echo row (F-213).
     */
    val downloadHandler: CefDownloadHandler = createDownloadHandler(
        onStart = { kernel.onDownloadStarted() },
        onDone = { ok, path -> kernel.onDownloadFinished(ok, path) },
        onProgress = { name, received, total -> kernel.onDownloadProgress(name, received, total) },
    )

    // ---- certificate errors + renderer death (043 hook, F-110 ABI bridge) ----

    val requestHandler: CefRequestHandler = createRequestHandler()

    // ---- load lifecycle ----

    val loadHandler = object : CefLoadHandlerAdapter() {
        override fun onLoadEnd(browser: CefBrowser, frame: CefFrame?, httpStatusCode: Int) {
            if (frame?.isMain == true) kernel.onEvent(PiBrowserEvent.LoadEnd)
        }

        override fun onLoadError(browser: CefBrowser, frame: CefFrame?, errorCode: CefLoadHandler.ErrorCode?, errorText: String?, failedUrl: String?) {
            // ERR_ABORTED also fires when a new navigation cancels the old
            // load — not a failure (same rule as the chat panel).
            if (frame?.isMain != true) return
            if (errorCode == CefLoadHandler.ErrorCode.ERR_ABORTED) return
            if (failedUrl.isNullOrBlank()) return
            kernel.onEvent(PiBrowserEvent.LoadError(errorCode?.name ?: "UNKNOWN", LogSafe.truncate(errorText)))
        }

        /**
         * F-102 root cause 1: back()/forward() produce no kernel event and
         * their trailing LoadEnd is dropped in LOADED, so nobody re-read
         * canGoForward and the forward button stayed grey. CEF hands the
         * authoritative flags here for EVERY loading-state flip (buttons,
         * in-page links, stop) — sync them straight through, state machine
         * untouched.
         */
        override fun onLoadingStateChange(browser: CefBrowser?, isLoading: Boolean, canGoBack: Boolean, canGoForward: Boolean) {
            kernel.onNavStateChanged(canGoBack, canGoForward)
        }
    }

    // ---- address / title echo ----

    val displayHandler = object : CefDisplayHandlerAdapter() {
        override fun onAddressChange(browser: CefBrowser, frame: CefFrame?, url: String) {
            if (frame?.isMain != true) return
            // F-201: raw URL into the project history (the carrier filters
            // preview tokens). F-103: raw URL into the UI echo as well — the
            // address bar shows query-only navigations correctly. LogSafe
            // stays ONLY on the idea.log call sites (this file's log lines).
            kernel.feedNavigationHistory(url)
            kernel.onAddressChanged(url)
        }

        override fun onTitleChange(browser: CefBrowser, title: String?) {
            kernel.onTitleChanged(LogSafe.truncate(title))
        }
    }

    // ---- keyboard (F-202 shortcuts, F-205 zoom, F-204 find) ----

    /**
     * The page's native window is the only place these keys arrive when the
     * user browses (CEF has no built-in browser accelerators). Swing-side
     * bindings for the same set live in [BrowserPanel] for the toolbar focus.
     */
    val keyboardHandler = object : CefKeyboardHandlerAdapter() {
        override fun onPreKeyEvent(browser: CefBrowser, event: CefKeyboardHandler.CefKeyEvent, isKeyboardShortcut: org.cef.misc.BoolRef?): Boolean {
            // F-202 round 2: Alt+Left/Right arrive as WM_SYSKEYDOWN ->
            // KEYEVENT_KEYDOWN (never RAWKEYDOWN on Windows - Ctrl+R/F5/Esc
            // keep the RAW path and verified working). Handled here or not at all.
            if (event.type == CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_KEYDOWN) {
                val m = event.modifiers
                if (m and FLAG_ALT != 0 && m and (FLAG_CONTROL or FLAG_SHIFT) == 0) {
                    return when (event.windows_key_code) {
                        VK_LEFT -> {
                            kernel.hopEdt { kernel.back() }
                            true
                        }
                        VK_RIGHT -> {
                            kernel.hopEdt { kernel.forward() }
                            true
                        }
                        else -> false
                    }
                }
                return false
            }
            if (event.type != CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_RAWKEYDOWN) return false
            // Zoom first: no overlap with the nav keys below.
            if (JcefBrowserZoom.onPreKeyEvent(kernel.currentJbBrowser()?.cefBrowser, event)) return true
            val m = event.modifiers
            return when (event.windows_key_code) {
                VK_F -> if (m and FLAG_CONTROL != 0 && m and (FLAG_ALT or FLAG_SHIFT) == 0) {
                    kernel.hopEdt { kernel.onFindRequest?.invoke() }
                    true
                } else false
                VK_ESCAPE -> when {
                    kernel.isFindBarOpen() -> {
                        kernel.hopEdt { kernel.onFindClose?.invoke() }
                        true
                    }
                    kernel.state == PiBrowserState.LOADING -> {
                        kernel.hopEdt { kernel.stop() }
                        true
                    }
                    else -> false // pass through to the page
                }
                VK_LEFT -> if (m and FLAG_ALT != 0 && m and (FLAG_CONTROL or FLAG_SHIFT) == 0) {
                    kernel.hopEdt { kernel.back() }
                    true
                } else false
                VK_RIGHT -> if (m and FLAG_ALT != 0 && m and (FLAG_CONTROL or FLAG_SHIFT) == 0) {
                    kernel.hopEdt { kernel.forward() }
                    true
                } else false
                VK_R, VK_F5 -> if (m and FLAG_CONTROL != 0 || event.windows_key_code == VK_F5) {
                    if (m and (FLAG_ALT or FLAG_SHIFT) == 0) {
                        kernel.hopEdt { kernel.reload() }
                        true
                    } else false
                } else false
                else -> false
            }
        }
    }

    // ---- context menu (F-104/F-211: additive, native items preserved) ----

    /**
     * Link right-clicks APPEND the destination items after a separator
     * (054 变更 1: system browser / Pi browser tab / copy / Pi editor) —
     * F-211: the 049 build cleared the whole model, which deleted "open in
     * new tab / copy link address / save image". Returning false for foreign
     * command ids hands every native item back to CEF.
     */
    val contextMenuHandler = object : CefContextMenuHandlerAdapter() {
        override fun onBeforeContextMenu(browser: CefBrowser, frame: CefFrame?, params: CefContextMenuParams, model: CefMenuModel) {
            if (!appendLinkItems(model, params.linkUrl ?: "")) return
        }

        override fun onContextMenuCommand(browser: CefBrowser, frame: CefFrame?, params: CefContextMenuParams, commandId: Int, eventFlags: Int): Boolean {
            val url = params.linkUrl
            if (url.isNullOrBlank()) return false
            when (commandId) {
                MENU_ID_OPEN_SYSTEM -> BrowserUtil.browse(url)
                MENU_ID_OPEN_EMBEDDED -> kernel.load(url) // in-place: this kernel (editor carrier stays in its tab)
                MENU_ID_COPY_LINK -> kernel.hopEdt {
                    CopyPasteManager.getInstance().setContents(StringSelection(url))
                }
                // 054 变更 1: the link URL opens in an editor-form tab — its
                // own kernel, this tab stays untouched. EDT hop: the CEF
                // callback thread must not touch FileEditorManager.
                MENU_ID_OPEN_PI_EDITOR -> kernel.hopEdt {
                    PiBrowserEditorProvider.openUrlInEditor(kernel.hostProject, url, null)
                }
                else -> return false // native items -> CEF
            }
            return true
        }
    }

    // ---- JS dialogs (F-207: CefClient drops them silently without a handler) ----

    /**
     * alert/confirm/prompt surface as Swing dialogs on the EDT; the CEF
     * callback MUST be continued exactly once after the user closes the
     * dialog, or the page's JS hangs forever. The `done` guard makes that
     * true even if a dialog path throws.
     */
    val jsDialogHandler = object : CefJSDialogHandlerAdapter() {
        override fun onJSDialog(
            browser: CefBrowser,
            originUrl: String,
            dialogType: CefJSDialogHandler.JSDialogType,
            messageText: String,
            defaultPromptText: String,
            callback: org.cef.callback.CefJSDialogCallback,
            suppressMessage: org.cef.misc.BoolRef?,
        ): Boolean {
            ApplicationManager.getApplication().invokeLater {
                var done = false
                fun finish(ok: Boolean, input: String) {
                    if (!done) {
                        done = true
                        runCatching { callback.Continue(ok, input) }
                    }
                }
                try {
                    // CefJSDialogHandler carries no dialog title — the page
                    // origin is the best label we have.
                    val title = originUrl.ifBlank { "JavaScript" }
                    when (dialogType) {
                        CefJSDialogHandler.JSDialogType.JSDIALOGTYPE_CONFIRM -> {
                            val yes = Messages.showYesNoDialog(messageText, title, Messages.getQuestionIcon()) == Messages.YES
                            finish(yes, "")
                        }
                        CefJSDialogHandler.JSDialogType.JSDIALOGTYPE_PROMPT -> {
                            val input = Messages.showInputDialog(messageText, title, Messages.getQuestionIcon(), defaultPromptText, null)
                            finish(input != null, input ?: "")
                        }
                        else -> {
                            Messages.showInfoMessage(messageText, title)
                            finish(true, "")
                        }
                    }
                } catch (_: Throwable) {
                    finish(false, "")
                }
            }
            return true // handled: CEF must not show its own (invisible) dialog
        }

        override fun onBeforeUnloadDialog(browser: CefBrowser?, messageText: String?, isReload: Boolean, callback: org.cef.callback.CefJSDialogCallback?): Boolean {
            val message = messageText ?: ""
            val cb = callback ?: return false
            ApplicationManager.getApplication().invokeLater {
                runCatching {
                    val leave = Messages.showOkCancelDialog(
                        message.ifBlank { "Leave this page?" },
                        "Confirm navigation",
                        Messages.getQuestionIcon(),
                    ) == Messages.OK
                    cb.Continue(leave, "")
                }.onFailure { runCatching { cb.Continue(false, "") } }
            }
            return true
        }
    }

    // ---- focus (diagnostics only in P0; probe P-8: onTakeFocus is void) ----

    val focusHandler = object : CefFocusHandlerAdapter() {
        override fun onGotFocus(browser: CefBrowser) {
            log.debug("browser: got focus")
        }
    }

    private fun createRequestHandler(): CefRequestHandler = Proxy.newProxyInstance(
        PiBrowserHandlers::class.java.classLoader,
        arrayOf(CefRequestHandler::class.java),
    ) { _, method, args ->
        val a = args ?: emptyArray()
        when (method.name) {
            "onCertificateError" -> {
                val browser = a[0] as CefBrowser
                val errorCode = a[1] as CefLoadHandler.ErrorCode
                val requestUrl = a[2] as String
                @Suppress("UNCHECKED_CAST")
                val sslInfo = a[3] as? org.cef.security.CefSSLInfo
                val callback = a[4] as org.cef.callback.CefCallback
                val proceed = kernel.certPolicy.onError(errorCode.name, LogSafe.url(requestUrl), sslInfo?.statusBiset ?: -1)
                log.warn("browser cert error: " + errorCode.name + " " + LogSafe.url(requestUrl) + " -> " + if (proceed) "proceed" else "interstitial")
                if (proceed) callback.Continue() // capital C: the only proceed path (P-3)
                proceed
            }
            "onRenderProcessTerminated" -> {
                // Runtime ABI on 2026.2 is 4-arg; we only need the status.
                val status = a[1] as CefRequestHandler.TerminationStatus
                kernel.onEvent(PiBrowserEvent.RenderProcessGone(status.name))
                null // void
            }
            "onBeforeBrowse" -> {
                // F-110 round 2: on remote CEF (2025.2+) the thrift channel has
                // no DownloadHandler_* at all, so a page-linked download never
                // reaches ANY Java handler. Intercept download-shaped
                // navigations here, cancel, and fetch IDE-side instead.
                val request = a.getOrNull(2) as? org.cef.network.CefRequest
                val url = request?.getURL().orEmpty()
                if (PiDownloader.looksLikeDownload(url)) {
                    log.info("browser download intercepted at browse: " + LogSafe.url(url))
                    kernel.onDownloadUrlRequested(url)
                    true
                } else false
            }
            else -> defaultReturnValue(method)
        }
    } as CefRequestHandler

    companion object {

        // CEF event flags — chromium cef_event_flags_t values.
        private const val FLAG_SHIFT = 1 shl 0
        private const val FLAG_CONTROL = 1 shl 1
        private const val FLAG_ALT = 1 shl 2

        // Windows VK codes as CEF reports them in windows_key_code.
        private const val VK_ESCAPE = 0x1B
        private const val VK_LEFT = 0x25
        private const val VK_RIGHT = 0x27
        private const val VK_R = 0x52
        private const val VK_F = 0x46
        private const val VK_F5 = 0x74

        /** F-211: appended items live in the CEF user command-id range. */
        val MENU_ID_OPEN_SYSTEM = CefMenuModel.MenuId.MENU_ID_USER_FIRST
        val MENU_ID_OPEN_EMBEDDED = CefMenuModel.MenuId.MENU_ID_USER_FIRST + 1
        val MENU_ID_COPY_LINK = CefMenuModel.MenuId.MENU_ID_USER_FIRST + 2

        /** 054 变更 1: "Open in Pi editor" — the 4th appended destination. */
        val MENU_ID_OPEN_PI_EDITOR = CefMenuModel.MenuId.MENU_ID_USER_FIRST + 3

        /**
         * The link menu builder (054 变更 1). Appends one separator + the four
         * destination items for [url]; returns false WITHOUT touching the
         * model when the URL is blank (a blank link keeps the pure native
         * menu). Append-only by contract — never clear/remove native items
         * (F-211). Pulled out of the handler so the shape (ids, order, count)
         * is unit-testable headlessly via a reflective recording model
         * (PiBrowserLinkMenuTest).
         */
        internal fun appendLinkItems(model: CefMenuModel, url: String): Boolean {
            if (url.isBlank()) return false
            model.addSeparator()
            model.addItem(MENU_ID_OPEN_SYSTEM, PiAgentBundle.message("browser.link.option.SYSTEM_BROWSER"))
            model.addItem(MENU_ID_OPEN_EMBEDDED, PiAgentBundle.message("browser.link.option.EMBEDDED"))
            model.addItem(MENU_ID_COPY_LINK, PiAgentBundle.message("browser.link.option.COPY"))
            model.addItem(MENU_ID_OPEN_PI_EDITOR, PiAgentBundle.message("browser.link.option.PI_EDITOR"))
            return true
        }

        private fun defaultReturnValue(method: java.lang.reflect.Method): Any? = when (method.returnType) {
            java.lang.Boolean.TYPE -> false
            java.lang.Integer.TYPE -> 0
            else -> null
        }

        private fun downloadsDir(): File {
            val dir = File(System.getProperty("user.home"), "Downloads")
            dir.mkdirs()
            return dir
        }

        private fun uniqueTarget(dir: File, name: String): File {
            var candidate = File(dir, name)
            if (!candidate.exists()) return candidate
            val dot = name.lastIndexOf('.')
            val base = if (dot > 0) name.substring(0, dot) else name
            val ext = if (dot > 0) name.substring(dot) else ""
            var n = 1
            while (candidate.exists()) {
                candidate = File(dir, "$base ($n)$ext")
                n++
            }
            return candidate
        }

        private fun handleBeforeDownload(item: CefDownloadItem, suggestedName: String?, callback: CefBeforeDownloadCallback, onStart: (() -> Unit)?) {
            onStart?.invoke()
            val dir = downloadsDir()
            val cleaned = UrlNormalizer.downloadFileName(suggestedName)
            val target = uniqueTarget(dir, cleaned)
            // Native separators only: forward slashes stall the download in
            // CEF 122 with no error anywhere (probe P-4).
            callback.Continue(target.absolutePath, false)
            Logger.getInstance(PiBrowserHandlers::class.java)
                .info("browser download: " + LogSafe.url(item.getURL()) + " -> " + target.name)
        }

        private fun handleDownloadUpdated(
            item: CefDownloadItem,
            onDone: (Boolean, String) -> Unit,
            onProgress: ((String, Long, Long) -> Unit)?,
        ) {
            when {
                item.isComplete() -> onDone(true, item.getFullPath())
                item.isCanceled() -> onDone(false, item.getFullPath())
                onProgress != null && item.isValid && item.isInProgress() ->
                    onProgress(item.getSuggestedFileName() ?: "download", item.getReceivedBytes(), item.getTotalBytes())
            }
        }

        /**
         * F-110: builds the download handler against the RUNTIME-loaded
         * `CefDownloadHandler` interface (void-returning on 233–243 IDEs,
         * boolean-returning on 2025.2+/JCEF 144). The Proxy answers per the
         * invoked method's declared return type, so one build serves the
         * whole 233–263 line. Also used by the chat panel (F-213 defensive
         * registration) with its own completion notifier.
         */
        fun createDownloadHandler(
            onStart: (() -> Unit)?,
            onDone: (Boolean, String) -> Unit,
            onProgress: ((String, Long, Long) -> Unit)?,
        ): CefDownloadHandler =
            Proxy.newProxyInstance(
                PiBrowserHandlers::class.java.classLoader,
                arrayOf(CefDownloadHandler::class.java),
            ) { _, method, args ->
                val a = args ?: emptyArray()
                when (method.name) {
                    "onBeforeDownload" -> {
                        handleBeforeDownload(
                            a[1] as CefDownloadItem,
                            a[2] as? String,
                            a[3] as CefBeforeDownloadCallback,
                            onStart,
                        )
                        if (method.returnType == java.lang.Void.TYPE) null else true
                    }
                    "onDownloadUpdated" -> {
                        handleDownloadUpdated(a[1] as CefDownloadItem, onDone, onProgress)
                        if (method.returnType == java.lang.Void.TYPE) null else true
                    }
                    else -> defaultReturnValue(method)
                }
            } as CefDownloadHandler
    }
}
