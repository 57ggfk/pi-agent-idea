package dev.pi.agent.bridge

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 012 US7, T137: the image bridge's failure surface, without the IDE.
 * Dialogs and the system clipboard need a real application (manual test),
 * but the decode contract — fail loudly, return {ok:false, error}, never
 * throw — runs anywhere.
 */
class IdeImageActionsTest {

    @Test
    fun `missing and empty data are reported, not thrown`() {
        val missing = IdeImageActions.copyImage(buildJsonObject { })
        assertEquals("false", missing["ok"]!!.jsonPrimitive.content)
        assertTrue(missing["error"]!!.jsonPrimitive.content.contains("missing"))

        val empty = IdeImageActions.copyImage(buildJsonObject { put("data", "data:image/png;base64,") })
        assertEquals("false", empty["ok"]!!.jsonPrimitive.content)
        assertTrue(empty["error"]!!.jsonPrimitive.content.contains("empty"))
    }

    @Test
    fun `invalid base64 is an error, never an exception`() {
        val result = IdeImageActions.copyImage(buildJsonObject { put("data", "!!!not-base64!!!") })
        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertTrue(result["error"]!!.jsonPrimitive.content.contains("base64"))
    }

    @Test
    fun `decodable bytes without a real image report the decode failure`() {
        // valid base64 of garbage: ImageIO.read yields null
        val garbage = java.util.Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3, 4))
        val result = IdeImageActions.copyImage(buildJsonObject { put("data", garbage) })
        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertTrue(result["error"]!!.jsonPrimitive.content.contains("decodable image") || result["error"]!!.jsonPrimitive.content.contains("clipboard"))
    }

    @Test
    fun `a data url prefix is stripped before decoding`() {
        // 1x1 PNG; the decode must accept the data-url form and reach the
        // clipboard step (which fails without an Application — still a
        // structured error, not a throw).
        val png = java.util.Base64.getEncoder().encodeToString(
            byteArrayOf(
                0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG magic
                0, 0, 0, 13, 73, 72, 68, 82, // IHDR length+type
                0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15.toByte(), 0xC4.toByte(), 0x89.toByte(),
                0, 0, 0, 10, 73, 68, 65, 84, 120, 0x63.toByte(), 0, 1, 0, 0, 5, 0, 1, 0x0D, 0x0A, 0x2D, 0xB4.toByte(),
                0, 0, 0, 0, 73, 69, 78, 68, 0xAE.toByte(), 0x42, 0x60, 0x82.toByte(),
            ),
        )
        val result = IdeImageActions.copyImage(buildJsonObject { put("data", "data:image/png;base64,$png") })
        // without an Application the clipboard step errors — but the base64
        // and image-decode layers succeeded, so the error is about the
        // clipboard, not the data
        assertEquals("false", result["ok"]!!.jsonPrimitive.content)
        assertTrue(!result["error"]!!.jsonPrimitive.content.contains("base64"))
    }
}
