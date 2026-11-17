package dev.pi.agent.browser

/**
 * Pure URL/ filename helpers for the browser tab (spec 048 T002/T003).
 * No JCEF, no IDE classes — fully unit-testable.
 */
object UrlNormalizer {

    /**
     * Address-bar normalization. `null` = nothing to load.
     *
     * A bare host gets `http://` (the browser-address-bar convention); a value
     * with any scheme passes through untouched so `https://`, the preview
     * route, or a pasted `data:` URL survive as typed. Anything else (a stray
     * sentence, say) also gets the prefix and lands on the error card — spec
     * Q1's default: the address bar only builds URLs, it does not guess.
     */
    fun normalizeAddressBar(input: String?): String? {
        val trimmed = input?.trim() ?: return null
        if (trimmed.isEmpty()) return null
        // containsMatchIn with a ^ anchor: Regex.matches is a FULL-string
        // match, which a URL with a path never satisfies.
        return if (SCHEME_REGEX.containsMatchIn(trimmed)) trimmed else "http://$trimmed"
    }

    private val SCHEME_REGEX = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:")

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
