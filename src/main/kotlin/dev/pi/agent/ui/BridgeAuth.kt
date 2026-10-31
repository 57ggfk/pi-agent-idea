package dev.pi.agent.ui

/**
 * Origin rule for the bridge endpoints of [LocalUiServer]: browsers always
 * send Origin on cross-site POST/fetch, so a present foreign Origin is a
 * web-page CSRF attempt and is rejected. Token matching itself happens in
 * LocalUiServer against the per-project token registry.
 */
internal class BridgeAuth(private val ownOrigin: String) {

    fun originAllowed(origin: String?): Boolean = origin == null || origin == ownOrigin
}
