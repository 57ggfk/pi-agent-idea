package dev.pi.agent.editor

/**
 * Availability matrix for the file-popup actions (spec 009 US2).
 *
 * Kept as a pure function so the whole matrix is unit-testable without the
 * IntelliJ fixtures: `update()` derives a [TargetKind] from the DataContext,
 * then asks this function whether each action may run. Every disabled result
 * carries a human-readable reason (FR-004) — "the whole submenu is grey" was
 * exactly a directory target with only file actions, all disabled silently.
 */
enum class TargetKind { File, Directory, Binary, Oversized, Multi, None }

enum class PiFileAction { SendFile, ExplainFile, AddDirectory }

/** Whether [action] may run for [kind], and why not when it may not. */
data class Availability(val enabled: Boolean, val reason: String? = null)

/** Files above this size are refused by Send File (unchanged from 0.5.1). */
internal const val MAX_SEND_FILE_BYTES: Long = 256L * 1024

fun availability(action: PiFileAction, kind: TargetKind, multiHasDirectory: Boolean = false): Availability =
    when (action) {
        PiFileAction.SendFile -> when (kind) {
            TargetKind.File, TargetKind.Multi -> Availability(enabled = true)
            TargetKind.Directory -> Availability(
                false, "Folders cannot be sent as a file — use Add Directory to Pi",
            )
            TargetKind.Binary -> Availability(
                false, "Binary files cannot be sent as text — use Explain File with Pi instead",
            )
            TargetKind.Oversized -> Availability(
                false, "File is larger than ${MAX_SEND_FILE_BYTES / 1024} KB — use Explain File with Pi instead",
            )
            TargetKind.None -> Availability(false, "Select a file first")
        }

        PiFileAction.ExplainFile -> when (kind) {
            // Directories and binaries send the path only and let pi read from
            // disk (FR-005), so they are exactly the targets this action keeps
            // alive — a directory right-click never ends up all-grey again.
            TargetKind.File, TargetKind.Directory, TargetKind.Binary, TargetKind.Oversized, TargetKind.Multi ->
                Availability(enabled = true)
            TargetKind.None -> Availability(false, "Select a file first")
        }

        PiFileAction.AddDirectory -> when (kind) {
            TargetKind.Directory -> Availability(enabled = true)
            TargetKind.Multi -> if (multiHasDirectory) Availability(enabled = true)
            else Availability(false, "No directory in the selection — Add Directory lists a folder for pi")
            TargetKind.File, TargetKind.Binary, TargetKind.Oversized -> Availability(
                false, "Not a directory — Add Directory lists a folder for pi",
            )
            TargetKind.None -> Availability(false, "Select a directory first")
        }
    }
