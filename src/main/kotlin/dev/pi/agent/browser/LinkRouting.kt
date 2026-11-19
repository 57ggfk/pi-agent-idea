package dev.pi.agent.browser

/**
 * External-link routing decision (spec 048 T013, spec US4). Pure logic so
 * the three-state setting is testable without an IDE.
 */
enum class LinkTarget {
    SYSTEM, EMBEDDED, ASK;

    /** Localized display name for the settings dropdown. */
    fun displayName(): String = dev.pi.agent.PiAgentBundle.message("settings.linkTarget." + name)
}

sealed class LinkRoute {
    /** Hand the URL back to CEF untouched (loopback SPA navigation, blanks). */
    object CefDefault : LinkRoute()

    /** Hand it to the system browser — 037 semantics, the default. */
    object SystemBrowser : LinkRoute()

    /** Open in the in-app browser tab. */
    object Embedded : LinkRoute()

    /** Ask the user once per click. */
    object AskUser : LinkRoute()
}

object LinkRouting {

    /**
     * Loopback pages are the chat SPA's own origin — they must always stay
     * in the chat browser, whatever the setting says (037 hard rule).
     *
     * Host-based on purpose: the old prefix check (`http://localhost:`) missed
     * the port-less `http://localhost/` form, and any port/slash combination
     * should read as loopback, not just the ones the prefix happens to cover.
     */
    fun isLoopback(url: String): Boolean {
        if (!url.startsWith("http://")) return false
        val authority = url.removePrefix("http://").substringBefore('/')
        val host = authority.substringBefore(':')
        return host == "127.0.0.1" || host == "localhost"
    }

    /**
     * @param url raw navigation target (may be blank/loopback/external)
     * @param target user setting from [dev.pi.agent.settings.PiAgentSettings.linkTarget]
     */
    fun routeExternalLink(url: String?, target: LinkTarget): LinkRoute {
        if (url.isNullOrBlank()) return LinkRoute.CefDefault
        if (isLoopback(url)) return LinkRoute.CefDefault
        return when (target) {
            LinkTarget.SYSTEM -> LinkRoute.SystemBrowser
            LinkTarget.EMBEDDED -> LinkRoute.Embedded
            LinkTarget.ASK -> LinkRoute.AskUser
        }
    }
}
