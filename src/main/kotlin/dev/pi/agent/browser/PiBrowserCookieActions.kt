package dev.pi.agent.browser

import com.intellij.ui.jcef.JBCefCookieManager

/**
 * Cookie actions for the in-app browser surfaces (F-215 M2).
 *
 * The platform's global JCEF cookie jar is persistent since 243 (F-215:
 * `jcef_cache/Default/Network/Cookies` on disk), which is what makes form
 * logins usable across IDE restarts at all. "Clear" is the user's escape
 * hatch when a session goes stale — the API exists on the whole supported
 * line (`JBCefCookieManager.deleteCookies`), with no flush call needed: the
 * manager persists deletions through its own store handling (there is no
 * `flushStore` on the 243 platform class — that part of the original plan
 * does not exist).
 */
object PiBrowserCookieActions {

    /** Clears ALL cookies of the shared JCEF profile. Returns success. */
    fun clearAll(): Boolean =
        try {
            JBCefCookieManager.getGlobalJBCefCookieManager()?.deleteCookies(true) ?: false
        } catch (_: Throwable) {
            false
        }

    /**
     * Clears cookies matching [urlOrigin] (scheme+host, e.g. `https://example.com`).
     * Returns success; null-safe when no manager exists yet.
     */
    fun clearFor(urlOrigin: String): Boolean =
        try {
            JBCefCookieManager.getGlobalJBCefCookieManager()
                ?.deleteCookies(urlOrigin, true) ?: false
        } catch (_: Throwable) {
            false
        }
}
