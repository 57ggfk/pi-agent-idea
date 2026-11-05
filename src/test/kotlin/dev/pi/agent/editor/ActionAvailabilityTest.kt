package dev.pi.agent.editor

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Availability matrix for the project-tree popup (spec 009 US2 / FR-003…FR-006):
 * five target kinds × three actions. A disabled action must always carry a
 * human-readable reason — "silently grey" is the bug this feature fixes.
 */
class ActionAvailabilityTest {

    private fun enabled(action: PiFileAction, kind: TargetKind, multiHasDirectory: Boolean = false) =
        availability(action, kind, multiHasDirectory).let {
            assertTrue(it.enabled, "$action/$kind should be enabled")
            assertNull(it.reason, "$action/$kind should have no reason")
        }

    private fun disabled(action: PiFileAction, kind: TargetKind, multiHasDirectory: Boolean = false) =
        availability(action, kind, multiHasDirectory).let {
            assertFalse(it.enabled, "$action/$kind should be disabled")
            assertTrue(!it.reason.isNullOrBlank(), "$action/$kind must explain why it is disabled")
        }

    // -- Send File to Pi -----------------------------------------------------

    @Test
    fun `send file works for plain text files`() = enabled(PiFileAction.SendFile, TargetKind.File)

    @Test
    fun `send file works for multi-selection (first file wins)`() = enabled(PiFileAction.SendFile, TargetKind.Multi)

    @Test
    fun `send file refuses directories and points at Add Directory`() =
        disabled(PiFileAction.SendFile, TargetKind.Directory)

    @Test
    fun `send file refuses binary files with a reason`() = disabled(PiFileAction.SendFile, TargetKind.Binary)

    @Test
    fun `send file refuses oversized files with a reason`() = disabled(PiFileAction.SendFile, TargetKind.Oversized)

    @Test
    fun `send file refuses a missing target`() = disabled(PiFileAction.SendFile, TargetKind.None)

    // -- Explain File with Pi ------------------------------------------------

    @Test
    fun `explain works for plain text files`() = enabled(PiFileAction.ExplainFile, TargetKind.File)

    @Test
    fun `explain works for directories (structure summary)`() =
        enabled(PiFileAction.ExplainFile, TargetKind.Directory)

    @Test
    fun `explain works for binary files (path only, pi reads from disk)`() =
        enabled(PiFileAction.ExplainFile, TargetKind.Binary)

    @Test
    fun `explain works for oversized files`() = enabled(PiFileAction.ExplainFile, TargetKind.Oversized)

    @Test
    fun `explain works for multi-selection`() = enabled(PiFileAction.ExplainFile, TargetKind.Multi)

    @Test
    fun `explain refuses a missing target`() = disabled(PiFileAction.ExplainFile, TargetKind.None)

    // -- Add Directory to Pi -------------------------------------------------

    @Test
    fun `add directory works for directories`() = enabled(PiFileAction.AddDirectory, TargetKind.Directory)

    @Test
    fun `add directory works for a multi-selection containing a directory`() =
        enabled(PiFileAction.AddDirectory, TargetKind.Multi, multiHasDirectory = true)

    @Test
    fun `add directory is disabled for a files-only multi-selection`() =
        disabled(PiFileAction.AddDirectory, TargetKind.Multi, multiHasDirectory = false)

    @Test
    fun `add directory is disabled for file targets with a reason`() {
        disabled(PiFileAction.AddDirectory, TargetKind.File)
        disabled(PiFileAction.AddDirectory, TargetKind.Binary)
        disabled(PiFileAction.AddDirectory, TargetKind.Oversized)
    }

    @Test
    fun `add directory refuses a missing target`() = disabled(PiFileAction.AddDirectory, TargetKind.None)

    // -- disabled reasons are readable (FR-004) -------------------------------

    @Test
    fun `directory refusal for send file mentions the alternative`() {
        val a = availability(PiFileAction.SendFile, TargetKind.Directory)
        assertTrue(a.reason!!.contains("Add Directory"), "reason should point at the alternative: ${a.reason}")
    }
}
