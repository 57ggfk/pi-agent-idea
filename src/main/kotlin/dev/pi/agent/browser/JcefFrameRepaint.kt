package dev.pi.agent.browser

import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.jcef.JBCefBrowser

/**
 * Forces a full CEF frame repaint after a large DOM swap (spec 060 T005).
 *
 * Extracted verbatim from `PiAgentPanel.repaintBrowser` (0.5.4): after a big
 * view change the on-screen frame could stay stale for seconds to minutes —
 * the user literally saw the previous view's remains under the new one (probe
 * P-9; the probe plugin hit the same residue in its windowed panel). The impl
 * class is package-private, so the refresh goes through reflection:
 * `CefBrowser_N.wasResized` makes the renderer produce a fresh full frame even
 * at an unchanged size. Both the chat panel and the browser kernel use this.
 */
object JcefFrameRepaint {

    fun forceRepaint(browser: JBCefBrowser?) {
        val current = browser ?: return
        ApplicationManager.getApplication().invokeLater {
            runCatching {
                val component = current.component
                component.revalidate()
                component.repaint()
                val cef = current.cefBrowser
                cef.javaClass
                    .getMethod("wasResized", Integer.TYPE, Integer.TYPE)
                    .apply { isAccessible = true }
                    .invoke(cef, component.width.coerceAtLeast(1), component.height.coerceAtLeast(1))
            }
        }
    }
}
