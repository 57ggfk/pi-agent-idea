package dev.pi.agent.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BridgeAuthTest {

    private val auth = BridgeAuth(ownOrigin = "http://127.0.0.1:12345")

    @Test
    fun `same origin or absent origin is allowed`() {
        assertTrue(auth.originAllowed(null))
        assertTrue(auth.originAllowed("http://127.0.0.1:12345"))
    }

    @Test
    fun `foreign origin is rejected`() {
        // Web-page CSRF: the attacker page cannot know the token, and a present
        // foreign Origin is rejected regardless.
        assertFalse(auth.originAllowed("https://evil.example"))
        assertFalse(auth.originAllowed("null"))
        assertFalse(auth.originAllowed("http://localhost:12345"))
    }

    @Test
    fun `generated token is url-safe base64 of 32 bytes`() {
        val token = LocalUiServer.generateToken()
        assertEquals(43, token.length) // 32 bytes → 43 unpadded base64url chars
        assertFalse(token.contains('='))
        assertTrue(token.all { it.isLetterOrDigit() || it == '-' || it == '_' })
        // Two invocations never collide.
        assertTrue(token != LocalUiServer.generateToken())
    }
}
