package dev.pi.agent.browser

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Spec 048 T015/T016 — the preview registration's lifetime contract.
 *
 * The token is RE-FETCHABLE for its TTL (the browser panel's RELOAD re-requests
 * the same URL; a single-use token turned every refresh into an error card),
 * and the file that backs it lives exactly as long as the token. The UI
 * server therefore only ever gets BYTES — the file's lifetime belongs to the
 * registry, so the rule can be asserted here instead of hiding in an HTTP
 * handler.
 */
class PiBrowserPreviewsServeTest {

    @Test
    fun `the same token can be served twice - a reload must still work`() {
        val file = Files.createTempFile(PiBrowserPreviews.previewRoot(), "t-serve-", ".html")
        Files.writeString(file, "<html><body>pi preview</body></html>")
        val token = PiBrowserPreviews.register(file)

        val first = PiBrowserPreviews.serve(token)
        assertNotNull(first, "first fetch must serve the preview")
        assertEquals("<html><body>pi preview</body></html>", String(first))

        val second = PiBrowserPreviews.serve(token)
        assertNotNull(second, "reload must serve the preview again within the TTL")
        assertEquals("<html><body>pi preview</body></html>", String(second))

        assertTrue(Files.exists(file), "the preview file must survive being fetched")
    }

    @Test
    fun `an expired token serves nothing and takes its file with it`() {
        val file = Files.createTempFile(PiBrowserPreviews.previewRoot(), "t-expire-", ".html")
        Files.writeString(file, "<html>gone</html>")
        val token = PiBrowserPreviews.register(file)

        val afterExpiry = System.currentTimeMillis() + PiBrowserPreviews.TTL_MS + 1
        assertNull(PiBrowserPreviews.serve(token, nowMs = afterExpiry), "an expired token must serve nothing")
        assertTrue(!Files.exists(file), "an expired preview file must be deleted")
    }

    @Test
    fun `an unknown token serves nothing`() {
        assertNull(PiBrowserPreviews.serve("deadbeef".repeat(4)))
    }
}
