package dev.pi.agent.browser

import org.cef.browser.CefBrowser
import org.cef.handler.CefKeyboardHandler

/**
 * Ctrl +/-/0 page zoom for the plugin's JCEF surfaces (F-205). CEF carries no
 * browser-level zoom accelerator (that is Chrome UI-layer behavior), and the
 * platform JBCefBrowser exposes no zoom API — but the CEF keyboard handler
 * receives the raw keys and `CefBrowser.setZoomLevel` is public API on the
 * whole 233–263 line, so the host implements the accelerator itself.
 *
 * Shared by the browser kernel (PiBrowserHandlers.keyboardHandler) and the
 * chat panel (PiAgentPanel) so both surfaces zoom the same way, mirroring the
 * [JcefFrameRepaint] pattern of one workaround object, two consumers.
 *
 * CEF event flags follow chromium's cef_event_flags_t:
 * EVENTFLAG_CONTROL_DOWN = 1 << 1, EVENTFLAG_ALT_DOWN = 1 << 2,
 * EVENTFLAG_SHIFT_DOWN = 1 << 0. Plain-char keys only (no numpad variants of
 * `+`/`-` beyond VK_ADD/VK_SUBTRACT, which Chromium reports as windows codes
 * 107/109).
 */
object JcefBrowserZoom {

    private const val STEP = 0.5
    private const val MIN_LEVEL = -4.0
    private const val MAX_LEVEL = 4.0

    /** Java KeyEvent VK codes as CEF reports them in windows_key_code. */
    private const val KEY_PLUS = 0xBB // VK_OEM_PLUS ('='/'+' key)
    private const val KEY_NUMPAD_PLUS = 0x6B // VK_ADD
    private const val KEY_MINUS = 0xBD // VK_OEM_MINUS
    private const val KEY_NUMPAD_MINUS = 0x6D // VK_SUBTRACT
    private const val KEY_ZERO = 0x30 // '0'

    private const val FLAG_SHIFT_DOWN = 1 shl 0
    private const val FLAG_CONTROL_DOWN = 1 shl 1
    private const val FLAG_ALT_DOWN = 1 shl 2

    /**
     * Consumes Ctrl +/-/0 raw key downs and applies the zoom to [cef].
     * Returns true when the key was a zoom key (caller must not pass it to
     * the page). Everything else returns false untouched.
     */
    fun onPreKeyEvent(cef: CefBrowser?, event: CefKeyboardHandler.CefKeyEvent): Boolean {
        if (cef == null) return false
        if (event.type != CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_RAWKEYDOWN) return false
        val m = event.modifiers
        if (m and FLAG_CONTROL_DOWN == 0 || m and (FLAG_ALT_DOWN or FLAG_SHIFT_DOWN) != 0) return false
        return when (event.windows_key_code) {
            KEY_PLUS, KEY_NUMPAD_PLUS -> {
                zoomIn(cef)
                true
            }
            KEY_MINUS, KEY_NUMPAD_MINUS -> {
                zoomOut(cef)
                true
            }
            KEY_ZERO -> {
                zoomReset(cef)
                true
            }
            else -> false
        }
    }

    /** One zoom step in / out / reset, clamped to ±4 (public for the Swing-side bindings). */
    fun zoomIn(cef: CefBrowser?) {
        if (cef != null) cef.setZoomLevel((cef.zoomLevel + STEP).coerceAtMost(MAX_LEVEL))
    }

    fun zoomOut(cef: CefBrowser?) {
        if (cef != null) cef.setZoomLevel((cef.zoomLevel - STEP).coerceAtLeast(MIN_LEVEL))
    }

    fun zoomReset(cef: CefBrowser?) {
        if (cef != null) cef.setZoomLevel(0.0)
    }
}
