package dev.pi.agent.browser

/**
 * Log-scrubbing helpers for the browser kernel (spec 048 T004, hard
 * constraint 8). The chat panel logs page console output because that page is
 * ours; the browser tab renders untrusted sites, so their URLs (queries often
 * carry session tokens of OTHER services) and console output must never reach
 * idea.log verbatim.
 */
object LogSafe {

    /**
     * `https://host/path?secret=x#frag` -> `https://host/path`. Keeps enough
     * to diagnose "which site failed", drops everything a user would not
     * want in a pasted log.
     */
    fun url(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        val withoutFragment = raw.substringBefore('#')
        val queryStart = withoutFragment.indexOf('?')
        val stripped = if (queryStart >= 0) withoutFragment.substring(0, queryStart) else withoutFragment
        return truncate(stripped, MAX_URL)
    }

    /** Hard cap for any incidental text (console lines, exception messages). */
    fun truncate(raw: String?, max: Int = MAX_TEXT): String {
        if (raw == null) return ""
        val oneLine = raw.replace('\n', ' ').replace('\r', ' ')
        return if (oneLine.length <= max) oneLine else oneLine.take(max) + "…(+" + (oneLine.length - max) + ")"
    }

    private const val MAX_URL = 300
    private const val MAX_TEXT = 200
}
