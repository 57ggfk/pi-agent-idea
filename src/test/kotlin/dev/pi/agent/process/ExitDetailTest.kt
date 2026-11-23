package dev.pi.agent.process

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The exit notice is rendered verbatim in the panel, so the exit code must
 * appear exactly once: pi's own EOF message already carries `(exit code N)`
 * and the process manager used to append it a second time.
 */
class ExitDetailTest {

    @Test
    fun `an exit code already in the message is not repeated`() {
        assertEquals(
            "pi process closed stdout (exit code 1)",
            exitDetail("pi process closed stdout (exit code 1)", 1),
        )
    }

    @Test
    fun `a missing exit code is appended`() {
        assertEquals(
            "pi process closed stdout (exit code 1)",
            exitDetail("pi process closed stdout", 1),
        )
    }

    @Test
    fun `a clean exit carries no code`() {
        assertEquals("pi process closed stdout", exitDetail("pi process closed stdout", 0))
        assertEquals("pi process closed stdout", exitDetail("pi process closed stdout", null))
    }

    @Test
    fun `another code in the message is not mistaken for this one`() {
        assertEquals(
            "already (exit code 10) (exit code 1)",
            exitDetail("already (exit code 10)", 1),
        )
    }

    @Test
    fun `an empty message still gets its code`() {
        assertEquals("(exit code 1)", exitDetail("", 1))
    }
}
