package dev.pi.agent.browser

import com.intellij.openapi.diagnostic.Logger
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefBeforeDownloadCallback
import org.cef.callback.CefDownloadItemCallback
import org.cef.callback.CefDownloadItem
import org.cef.handler.CefDisplayHandlerAdapter
import org.cef.handler.CefDownloadHandler
import org.cef.handler.CefFocusHandlerAdapter
import org.cef.handler.CefLifeSpanHandlerAdapter
import org.cef.handler.CefLoadHandler
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandler
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.io.File

/**
 * The browser tab's CEF handler set (spec 048 T007). Every non-obvious choice
 * here was verified on the real machine (probe P-1…P-12, plan §0) — do not
 * "simplify" without re-reading them:
 *
 *  - popups: `onBeforePopup` on the LIFESPAN handler is the only interception
 *    point (the request handler has no popup callback and `onOpenURLFromTab`
 *    does not receive target=_blank). Returning true cancels the popup; the
 *    kernel then loads the URL in place. Silent drops are forbidden — a
 *    real-machine session with the drop-only variant read as "links are dead"
 *    (spec 048 US5).
 *  - downloads: without a handler CEF cancels the download and the file
 *    vanishes; `Continue` MUST get a native-backslash path or the download
 *    silently stalls (P-4).
 *  - certificates: strict by default — CEF shows its readable interstitial
 *    page, never a white screen (P-3). Policy relaxation is 043's job via
 *    [PiCertPolicy]; the CDP proceed path does not work.
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

    // ---- downloads ----

    val downloadHandler = object : CefDownloadHandler {
        override fun onBeforeDownload(browser: CefBrowser, item: CefDownloadItem, suggestedName: String?, callback: CefBeforeDownloadCallback) {
            val dir = downloadsDir()
            val cleaned = UrlNormalizer.downloadFileName(suggestedName)
            val target = uniqueTarget(dir, cleaned)
            // Native separators only: forward slashes stall the download in
            // CEF 122 with no error anywhere (probe P-4).
            callback.Continue(target.absolutePath, false)
            log.info("browser download: " + LogSafe.url(item.getURL()) + " -> " + target.name)
        }

        override fun onDownloadUpdated(browser: CefBrowser, item: CefDownloadItem, callback: CefDownloadItemCallback) {
            if (item.isComplete()) kernel.onDownloadFinished(true, item.getFullPath())
            else if (item.isCanceled()) kernel.onDownloadFinished(false, item.getFullPath())
        }
    }

    // ---- certificate errors (043 hook) ----

    val requestHandler = object : CefRequestHandlerAdapter() {
        override fun onCertificateError(
            browser: CefBrowser,
            errorCode: CefLoadHandler.ErrorCode,
            requestUrl: String,
            sslInfo: org.cef.security.CefSSLInfo?,
            callback: org.cef.callback.CefCallback,
        ): Boolean {
            val proceed = kernel.certPolicy.onError(errorCode.name, LogSafe.url(requestUrl), sslInfo?.statusBiset ?: -1)
            log.warn("browser cert error: " + errorCode.name + " " + LogSafe.url(requestUrl) + " -> " + if (proceed) "proceed" else "interstitial")
            if (proceed) callback.Continue() // capital C: the only proceed path (P-3)
            return proceed
        }

        override fun onRenderProcessTerminated(browser: CefBrowser, status: CefRequestHandler.TerminationStatus) {
            kernel.onEvent(PiBrowserEvent.RenderProcessGone(status.name))
        }
    }

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
    }

    // ---- address / title echo ----

    val displayHandler = object : CefDisplayHandlerAdapter() {
        override fun onAddressChange(browser: CefBrowser, frame: CefFrame?, url: String) {
            if (frame?.isMain == true) kernel.onAddressChanged(LogSafe.url(url))
        }

        override fun onTitleChange(browser: CefBrowser, title: String?) {
            kernel.onTitleChanged(LogSafe.truncate(title))
        }
    }

    // ---- focus (diagnostics only in P0; probe P-8: onTakeFocus is void) ----

    val focusHandler = object : CefFocusHandlerAdapter() {
        override fun onGotFocus(browser: CefBrowser) {
            log.debug("browser: got focus")
        }
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
}
