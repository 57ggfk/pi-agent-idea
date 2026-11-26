package dev.pi.agent.browser

/**
 * Pure URL/ filename helpers for the browser tab (spec 060 T002/T003).
 * No JCEF, no IDE classes — fully unit-testable.
 */
object UrlNormalizer {

    /** What the user typed into the address bar (F-212: URL or search). */
    sealed class AddressInput {
        /** A loadable URL (typed with a scheme, or a host-shaped value). */
        data class Url(val url: String) : AddressInput()

        /** Not URL-shaped — a search query (F-212 flips spec 060 Q1). */
        data class Search(val query: String) : AddressInput()
    }

    /**
     * Address-bar classification. A value with any scheme is a URL verbatim
     * (`https://`, the preview route, a pasted `data:` URL); whitespace means
     * search; a bare host/localhost/IP/host:port gets `http://` (the
     * browser-address-bar convention); anything else is a search query.
     *
     * Q1 was re-answered by F-212: the old behavior (`http://` prefix on any
     * non-URL) punycode-mangled `react hooks` into an unusable host and landed
     * on the error card. The address bar now searches those like every real
     * browser does; the host-shaped forms keep the zero-surprise load.
     */
    fun parseAddressBar(input: String?): AddressInput {
        val trimmed = input?.trim() ?: return AddressInput.Search("")
        if (trimmed.isEmpty()) return AddressInput.Search("")
        // containsMatchIn with a ^ anchor: Regex.matches is a FULL-string
        // match, which a URL with a path never satisfies.
        if (SCHEME_REGEX.containsMatchIn(trimmed)) return AddressInput.Url(trimmed)
        if (trimmed.any { it.isWhitespace() }) return AddressInput.Search(trimmed)
        if (HOST_LIKE.containsMatchIn(trimmed)) return AddressInput.Url("http://$trimmed")
        return AddressInput.Search(trimmed)
    }

    /**
     * Programmatic-entry normalization ([AgentBrowserTool], actions): URL
     * inputs pass/build as before; a search-shaped value yields `null` —
     * callers that cannot show a search must not guess one either.
     */
    fun normalizeAddressBar(input: String?): String? =
        when (val parsed = parseAddressBar(input)) {
            is AddressInput.Url -> parsed.url
            is AddressInput.Search -> null
        }

    private val SCHEME_REGEX = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:")

    /**
     * Host-shaped without a scheme: localhost, IPv4, [IPv6], host:port, or a
     * dotted domain (`.tld` suffix required so `react hooks` never matches).
     */
    private val HOST_LIKE = Regex(
        "^(localhost|(?:\\d{1,3}\\.){3}\\d{1,3}|\\[[0-9a-fA-F:.]+\\]|(?:[A-Za-z0-9-]+\\.)+[A-Za-z]{2,})(:\\d{1,5})?([/?#].*)?$",
    )

    /**
     * Downloads: CEF hands us the server's suggested name. It is untrusted
     * input that becomes a native filesystem path via
     * `CefBeforeDownloadCallback.Continue(path, showDialog=false)` (probe P-4:
     * the path MUST use native backslashes or the download silently stalls).
     *
     * Strip path separators (traversal), Windows-reserved characters, control
     * characters; fall back when the result is blank or device-name-ish.
     */
    fun downloadFileName(suggested: String?): String {
        var name = (suggested ?: "").trim()
        // Drop any directory component the server may have smuggled in.
        name = name.substringAfterLast('\\').substringAfterLast('/')
        // Strip traversal remnants that survive the separator cut (e.g. "..x"
        // is harmless, but ".." alone would resolve against the download dir).
        if (name == "." || name == "..") name = ""
        // Windows-forbidden characters in a file name.
        name = name.replace(ILLEGAL_FILENAME_CHARS, "_")
        // Collapse runs and trim trailing underscores so "a:b*c?" does not
        // end with a stray separator lookalike.
        name = name.replace(Regex("_+"), "_").trimEnd('_')
        // Control characters (CJK full-width punctuation is legal and kept).
        name = name.filter { !it.isISOControl() }
        name = name.trim().trimEnd('.')
        if (name.isBlank() || name.uppercase() in WINDOWS_DEVICE_NAMES) {
            return "download.bin"
        }
        return name
    }

    private val ILLEGAL_FILENAME_CHARS = Regex("[\\\\/:*?\"<>|]")

    private val WINDOWS_DEVICE_NAMES = setOf(
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    )
}
