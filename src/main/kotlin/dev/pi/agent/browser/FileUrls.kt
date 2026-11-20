package dev.pi.agent.browser

import java.net.URI

/**
 * Pure `file:///` URL construction for user-initiated local opens (054
 * 变更 3). Spec 048 hard constraint 2 ("never `file://`") was RELAXED by the
 * user (2026-11-21) to exactly this narrow form: local files the user opens
 * through the "Open in Pi Browser / Editor" actions. The preview-token route
 * ([PiBrowserPreviews]) stays for everything else (chat export preview).
 *
 * No JCEF, no IDE classes — fully unit-testable (FileUrlsTest).
 */
object FileUrls {

    /**
     * Builds a triple-slash absolute `file:///` URL from a local path.
     *
     * Accepts what callers actually have: `VirtualFile.path` (forward
     * slashes, no scheme — `D:/code/a.html` on Windows, `/home/u/a.html`
     * otherwise) or a plain filesystem path with backslashes. Whitespace,
     * `#` and `?` are percent-encoded (CEF would otherwise split them off as
     * fragment/query); non-ASCII names come out as ASCII percent escapes via
     * [URI.toASCIIString]. A UNC path maps to the `file://host/share` form;
     * an input that already carries the `file://` scheme passes through.
     */
    fun forLocalFile(path: String): String {
        val trimmed = path.trim()
        if (trimmed.regionMatches(0, "file://", 0, 7, ignoreCase = true)) return trimmed
        val slashed = trimmed.replace('\\', '/')
        if (slashed.startsWith("//")) return "file:$slashed" // UNC: file://host/share
        val absolute = if (slashed.startsWith("/")) slashed else "/$slashed"
        return try {
            // Empty-string authority (not null): a null authority renders
            // "file:/C:/..." (single slash); an empty one gives the CEF-safe
            // triple-slash form.
            URI("file", "", absolute, null).toASCIIString()
        } catch (_: Exception) {
            // Malformed characters a URI cannot carry: hand the raw form back
            // and let the browser surface the (visible) load error instead.
            "file://$absolute"
        }
    }
}
