package dev.pi.agent.browser

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Spec 060 T015: the one-shot preview registry is the security boundary for
 * local HTML (hard constraint 2). Every rule here is a probe- or
 * threat-model-derived promise: unguessable token, single use, TTL, and
 * above all — the route never becomes a reader for arbitrary local files.
 */
class PiBrowserPreviewsTest {

    @Test
    fun `register returns a 128-bit hex token`() {
        val file = Files.createTempFile(PiBrowserPreviews.previewRoot(), "t1-", ".html")
        val token = PiBrowserPreviews.register(file)
        assertEquals(32, token.length, "16 bytes hex = 32 chars")
        assertTrue(token.all { it in "0123456789abcdef" })
    }

    @Test
    fun `token is refetchable within ttl, dead after expiry`() {
        val file = Files.createTempFile(PiBrowserPreviews.previewRoot(), "t2-", ".html")
        val token = PiBrowserPreviews.register(file)
        // Reload semantics: the panel re-fetches the same preview URL, so the
        // token stays alive within the TTL (060 amendment — first draft was
        // single-use, which turned every refresh into a 404 card).
        assertEquals(file, PiBrowserPreviews.take(token, nowMs = System.currentTimeMillis()))
        val justBeforeExpiry = System.currentTimeMillis() + PiBrowserPreviews.TTL_MS - 1
        assertEquals(file, PiBrowserPreviews.take(token, nowMs = justBeforeExpiry))
        val justAfterExpiry = System.currentTimeMillis() + PiBrowserPreviews.TTL_MS + 1
        assertNull(PiBrowserPreviews.take(token, nowMs = justAfterExpiry), "expired token must die")
        // The snapshot file is cleaned up with the dead token.
        assertTrue(!Files.exists(file), "expired preview file must be deleted")
    }

    @Test
    fun `unknown token rejected`() {
        assertNull(PiBrowserPreviews.take("deadbeef".repeat(4)))
    }

    @Test
    fun `registering outside the preview root is refused`() {
        val outside = Files.createTempFile("pi-outside-", ".html")
        assertFailsWith<IllegalArgumentException> {
            PiBrowserPreviews.register(outside)
        }
    }

    @Test
    fun `tokens are unique across registrations`() {
        val a = Files.createTempFile(PiBrowserPreviews.previewRoot(), "t3a-", ".html")
        val b = Files.createTempFile(PiBrowserPreviews.previewRoot(), "t3b-", ".html")
        val tokenA = PiBrowserPreviews.register(a)
        val tokenB = PiBrowserPreviews.register(b)
        assertTrue(tokenA != tokenB)
        assertEquals(a, PiBrowserPreviews.take(tokenA))
        assertEquals(b, PiBrowserPreviews.take(tokenB))
    }
}
