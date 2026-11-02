package dev.pi.agent.process

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * `--approve` lets pi trust project-local files for one run. The plugin must
 * add it only when the user explicitly authorised the project in this
 * session, never by default.
 */
class PiStartArgsTest {

    @Test
    fun `untrusted project starts without --approve`() {
        val args = PiStartArgs.build(model = null, approvalExtension = null, approveProjectFiles = false)
        assertEquals(listOf("--mode", "rpc"), args)
        assertFalse(args.contains("--approve"))
    }

    @Test
    fun `session grant adds --approve`() {
        val args = PiStartArgs.build(model = null, approvalExtension = null, approveProjectFiles = true)
        assertTrue(args.contains("--approve"))
        assertEquals("--approve", args.last(), "flags must not be interleaved with option values")
    }

    @Test
    fun `model and extension are preserved in order`() {
        val args = PiStartArgs.build(
            model = "anthropic" to "claude-sonnet-4",
            approvalExtension = "/tmp/pi-approve.js",
            approveProjectFiles = true,
        )
        assertEquals(
            listOf(
                "--mode", "rpc",
                "--provider", "anthropic",
                "--model", "claude-sonnet-4",
                "--extension", "/tmp/pi-approve.js",
                "--approve",
            ),
            args,
        )
    }

    @Test
    fun `approval is not implied by a restored model`() {
        val args = PiStartArgs.build(
            model = "openai" to "gpt-5",
            approvalExtension = null,
            approveProjectFiles = false,
        )
        assertFalse(args.contains("--approve"), "only an explicit grant may widen trust")
    }
}
