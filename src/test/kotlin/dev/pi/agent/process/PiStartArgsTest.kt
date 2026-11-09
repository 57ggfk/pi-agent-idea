package dev.pi.agent.process

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * `--approve` lets pi trust project-local files for one run. The plugin must
 * add it only when the user explicitly authorised the project in this
 * session, never by default.
 *
 * Spec 016 adds a second `--extension` (model reload): repeated flags must keep
 * a stable order, because the plugin relies on both extensions being loaded.
 */
class PiStartArgsTest {

    @Test
    fun `untrusted project starts without --approve`() {
        val args = PiStartArgs.build(model = null, extensions = emptyList(), approveProjectFiles = false)
        assertEquals(listOf("--mode", "rpc"), args)
        assertFalse(args.contains("--approve"))
    }

    @Test
    fun `session grant adds --approve`() {
        val args = PiStartArgs.build(model = null, extensions = emptyList(), approveProjectFiles = true)
        assertTrue(args.contains("--approve"))
        assertEquals("--approve", args.last(), "flags must not be interleaved with option values")
    }

    @Test
    fun `model and extension are preserved in order`() {
        val args = PiStartArgs.build(
            model = "anthropic" to "claude-sonnet-4",
            extensions = listOf("/tmp/pi-approve.js"),
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
    fun `both extensions ride along in a stable order`() {
        val args = PiStartArgs.build(
            model = null,
            extensions = listOf("/tmp/pi-approve.js", "/tmp/pi-models.js"),
            approveProjectFiles = false,
        )
        assertEquals(
            listOf(
                "--mode", "rpc",
                "--extension", "/tmp/pi-approve.js",
                "--extension", "/tmp/pi-models.js",
            ),
            args,
        )
        assertEquals(2, args.count { it == "--extension" })
        assertFalse(args.contains("--approve"))
    }

    @Test
    fun `approval is not implied by a restored model`() {
        val args = PiStartArgs.build(
            model = "openai" to "gpt-5",
            extensions = emptyList(),
            approveProjectFiles = false,
        )
        assertFalse(args.contains("--approve"), "only an explicit grant may widen trust")
    }
}
