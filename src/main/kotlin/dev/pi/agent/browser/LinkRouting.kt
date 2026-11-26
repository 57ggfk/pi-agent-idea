package dev.pi.agent.browser

/**
 * External-link routing decision (spec 060 T013, spec US4). Pure logic so
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

/**
 * One destination in the ask-mode link selector (spec 061 US1). Purely a
 * decision marker — the popup menu (icons, display) lives in the panel layer.
 */
enum class LinkOption {
    /** System default browser — "external = system default" stays verbatim (037). */
    SYSTEM_BROWSER,

    /** The in-app browser tab. */
    EMBEDDED,

    /** Copy the raw URL to the clipboard; the only uncluttered way to get it out of a rich chat. */
    COPY;

    /** Localized display name for the selector row. */
    fun label(): String = dev.pi.agent.PiAgentBundle.message("browser.link.option." + name)
}

object LinkRouting {

    /**
     * Ask-mode selector rows, display order locked by spec 061 Q3: system
     * browser first (the dominant intent for an external link — docs, issues,
     * npm pages), embedded second, copy third. Three is the ceiling: a menu
     * the user scans, not reads; each extra row dilutes the first two.
     */
    fun linkOptions(): List<LinkOption> = listOf(
        LinkOption.SYSTEM_BROWSER,
        LinkOption.EMBEDDED,
        LinkOption.COPY,
    )

    /**
     * The scheme+authority of [url] (e.g. `http://127.0.0.1:53451`), or null
     * when the URL has no parseable http(s) authority.
     */
    fun originOf(url: String?): String? {
        if (url == null) return null
        val m = Regex("^https?://[^/?#]+").find(url) ?: return null
        return m.value
    }

    /**
     * True when [url] points at the chat SPA's own origin [ownOrigin]. Only a
     * full scheme+authority match counts: 061 真机实证 the host-only loopback
     * check made every dev-server link (`http://127.0.0.1:8931/…`) read as the
     * SPA, so its target=_blank popup fell through to a raw white CEF window.
     */
    fun isOwnOrigin(url: String?, ownOrigin: String?): Boolean {
        if (url.isNullOrBlank() || ownOrigin.isNullOrBlank()) return false
        return originOf(url) == originOf(ownOrigin)
    }

    /**
     * Loopback pages are the chat SPA's own origin — they must always stay
     * in the chat browser, whatever the setting says (037 hard rule).
     *
     * Host-based on purpose for the LEGACY callers that have no own-origin
     * context; the routing entry point should prefer [routeExternalLink]'s
     * origin-aware overload, because a host-only check also swallows the AI's
     * dev-server links (`http://127.0.0.1:8931/`) — 061 真机缺陷。
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
        return routeBySetting(url, target)
    }

    /**
     * Origin-aware routing (061): the chat SPA's own origin stays in the chat
     * browser (037 hard rule, now port-exact); every other URL — including
     * loopback dev servers on OTHER ports — follows the setting.
     *
     * @param ownOrigin the chat SPA's `http://127.0.0.1:<port>` origin; when
     *   unknown, falls back to the legacy host-only loopback exemption.
     */
    fun routeExternalLink(url: String?, target: LinkTarget, ownOrigin: String?): LinkRoute {
        if (url.isNullOrBlank()) return LinkRoute.CefDefault
        if (ownOrigin.isNullOrBlank()) return routeExternalLink(url, target)
        if (isOwnOrigin(url, ownOrigin)) return LinkRoute.CefDefault
        return routeBySetting(url, target)
    }

    private fun routeBySetting(url: String, target: LinkTarget): LinkRoute = when (target) {
        LinkTarget.SYSTEM -> LinkRoute.SystemBrowser
        LinkTarget.EMBEDDED -> LinkRoute.Embedded
        LinkTarget.ASK -> LinkRoute.AskUser
    }
}
