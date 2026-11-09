package dev.pi.agent.editor

import dev.pi.agent.PiAgentBundle

/**
 * Availability matrix for the file-popup actions (spec 009 US2).
 *
 * Kept as a pure function so the whole matrix is unit-testable without the
 * IntelliJ fixtures: `update()` derives a [TargetKind] from the DataContext,
 * then asks this function whether each action may run. Every disabled result
 * carries a human-readable reason (FR-004) — "the whole submenu is grey" was
 * exactly a directory target with only file actions, all disabled silently.
 * Reasons come from the resource bundle so the popup bubble follows the IDE
 * language (spec 015).
 */
enum class TargetKind { File, Directory, Binary, Oversized, Multi, None }

enum class PiFileAction { SendFile, ExplainFile, AddDirectory }

/** Whether [action] may run for [kind], and why not when it may not. */
data class Availability(val enabled: Boolean, val reason: String? = null)

/** Files above this size were refused by Send File before spec 015; the
 *  classification stays (it feeds the matrix) although a reference no longer
 *  reads the file at all. */
internal const val MAX_SEND_FILE_BYTES: Long = 256L * 1024

fun availability(action: PiFileAction, kind: TargetKind, multiHasDirectory: Boolean = false): Availability =
    when (action) {
        PiFileAction.SendFile -> when (kind) {
            // Spec 015: the file travels as a path reference — nothing is
            // read, so binaries and oversized files are fine now too.
            TargetKind.File, TargetKind.Binary, TargetKind.Oversized, TargetKind.Multi ->
                Availability(enabled = true)
            TargetKind.Directory -> Availability(
                false, PiAgentBundle.message("availability.sendFile.directory"),
            )
            TargetKind.None -> Availability(false, PiAgentBundle.message("availability.selectFile"))
        }

        PiFileAction.ExplainFile -> when (kind) {
            // The file rides as a reference chip and pi reads from disk
            // (FR-005), so directories and binaries are exactly the targets
            // this action keeps alive — a directory right-click never ends up
            // all-grey again.
            TargetKind.File, TargetKind.Directory, TargetKind.Binary, TargetKind.Oversized, TargetKind.Multi ->
                Availability(enabled = true)
            TargetKind.None -> Availability(false, PiAgentBundle.message("availability.selectFile"))
        }

        PiFileAction.AddDirectory -> when (kind) {
            TargetKind.Directory -> Availability(enabled = true)
            TargetKind.Multi -> if (multiHasDirectory) Availability(enabled = true)
            else Availability(false, PiAgentBundle.message("availability.addDirectory.noDirectory"))
            TargetKind.File, TargetKind.Binary, TargetKind.Oversized -> Availability(
                false, PiAgentBundle.message("availability.addDirectory.notDirectory"),
            )
            TargetKind.None -> Availability(false, PiAgentBundle.message("availability.selectDirectory"))
        }
    }
