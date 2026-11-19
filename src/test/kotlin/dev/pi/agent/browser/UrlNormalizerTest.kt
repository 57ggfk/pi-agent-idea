package dev.pi.agent.browser

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Spec 048 T002/T003 locks. The download-name half exists because probe P-4
 * proved the download path is handed straight to the native filesystem —
 * the server's suggestion is untrusted input.
 */
class UrlNormalizerTest {

    // ---- address bar ----

    @Test
    fun `bare host gets http prefix`() {
        assertEquals("http://example.com", UrlNormalizer.normalizeAddressBar("example.com"))
        assertEquals("http://127.0.0.1:8771/fps.html", UrlNormalizer.normalizeAddressBar("127.0.0.1:8771/fps.html"))
    }

    @Test
    fun `schemed urls pass through untouched`() {
        assertEquals("https://a.b/c?d=1#e", UrlNormalizer.normalizeAddressBar("https://a.b/c?d=1#e"))
        assertEquals("http://localhost:8080", UrlNormalizer.normalizeAddressBar("http://localhost:8080"))
        assertEquals("data:text/html,<b>x</b>", UrlNormalizer.normalizeAddressBar("data:text/html,<b>x</b>"))
    }

    @Test
    fun `whitespace is trimmed not rejected`() {
        assertEquals("http://example.com", UrlNormalizer.normalizeAddressBar("  example.com  "))
    }

    @Test
    fun `blank and null refuse`() {
        assertNull(UrlNormalizer.normalizeAddressBar(null))
        assertNull(UrlNormalizer.normalizeAddressBar(""))
        assertNull(UrlNormalizer.normalizeAddressBar("   "))
    }

    @Test
    fun `non url input is a search per flipped spec q1`() {
        // Q1 was re-answered by F-212: the old `http://` prefix punycode-
        // mangled `react hooks` into an unusable host. Non-URL input is now
        // classified as a search; the programmatic normalizeAddressBar
        // declines it (null) instead of guessing.
        assertNull(UrlNormalizer.normalizeAddressBar("hello world"))
        assertNull(UrlNormalizer.normalizeAddressBar("react hooks"))
    }

    @Test
    fun `parseAddressBar classifies url host and search`() {
        // host-shaped inputs build URLs (zero-surprise load path kept)
        assertEquals(
            UrlNormalizer.AddressInput.Url("http://127.0.0.1:8931/"),
            UrlNormalizer.parseAddressBar("127.0.0.1:8931"),
        )
        assertEquals(
            UrlNormalizer.AddressInput.Url("http://localhost/fps.html"),
            UrlNormalizer.parseAddressBar("localhost/fps.html"),
        )
        assertEquals(
            UrlNormalizer.AddressInput.Url("http://example.com"),
            UrlNormalizer.parseAddressBar("example.com"),
        )
        // search-shaped inputs
        assertEquals(
            UrlNormalizer.AddressInput.Search("react hooks"),
            UrlNormalizer.parseAddressBar("react hooks"),
        )
        assertEquals(
            UrlNormalizer.AddressInput.Search("kotlin 协程"),
            UrlNormalizer.parseAddressBar("kotlin 协程"),
        )
        // a dotted string is host-shaped per the plan (含点域名) — loads like
        // an intranet host, exactly what a real address bar does
        assertEquals(
            UrlNormalizer.AddressInput.Url("http://what.is.this"),
            UrlNormalizer.parseAddressBar("what.is.this"),
        )
        // schemed values pass through verbatim
        assertEquals(
            UrlNormalizer.AddressInput.Url("data:text/html,<b>x</b>"),
            UrlNormalizer.parseAddressBar("data:text/html,<b>x</b>"),
        )
        // blank input: nothing to search for either
        assertEquals(UrlNormalizer.AddressInput.Search(""), UrlNormalizer.parseAddressBar("   "))
    }

    // ---- download file names ----

    @Test
    fun `plain name unchanged`() {
        assertEquals("probe042.bin", UrlNormalizer.downloadFileName("probe042.bin"))
    }

    @Test
    fun `path components are stripped not escaped`() {
        assertEquals("x.bin", UrlNormalizer.downloadFileName("..\\..\\x.bin"))
        assertEquals("x.bin", UrlNormalizer.downloadFileName("evil/x.bin"))
        assertEquals("x.bin", UrlNormalizer.downloadFileName("dir\\sub\\x.bin"))
    }

    @Test
    fun `traversal dots collapse to fallback`() {
        assertEquals("download.bin", UrlNormalizer.downloadFileName(".."))
        assertEquals("download.bin", UrlNormalizer.downloadFileName("."))
    }

    @Test
    fun `illegal windows characters replaced`() {
        assertEquals("a_b_c", UrlNormalizer.downloadFileName("a:b*c?"))
        assertEquals("report_2026.pdf", UrlNormalizer.downloadFileName("report:2026.pdf"))
    }

    @Test
    fun `blank or device name falls back`() {
        assertEquals("download.bin", UrlNormalizer.downloadFileName(null))
        assertEquals("download.bin", UrlNormalizer.downloadFileName("  "))
        assertEquals("download.bin", UrlNormalizer.downloadFileName("CON"))
        assertEquals("download.bin", UrlNormalizer.downloadFileName("com1"))
    }

    @Test
    fun `trailing dots trimmed`() {
        assertEquals("file.bin", UrlNormalizer.downloadFileName("file.bin..."))
    }

    @Test
    fun `cjk names are kept`() {
        // Full-width punctuation is legal on Windows; do not mangle CJK.
        assertEquals("报告：最终版.pdf", UrlNormalizer.downloadFileName("报告：最终版.pdf"))
    }
}
