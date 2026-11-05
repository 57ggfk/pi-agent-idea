package dev.pi.agent.bridge

import kotlinx.serialization.json.JsonObject

/**
 * Pure decision logic for VFS refresh after pi tool calls (spec 009 US4).
 *
 * The wiring (Alarm debounce, VirtualFileManager refresh, cache invalidation)
 * lives in BridgeService; only the "does this event refresh, and what" rules
 * are here so they are unit-testable without the platform.
 */
object VfsRefresh {

    /** Tools that mutate files; same set BridgeService uses for diff baselines. */
    val EDIT_TOOLS: Set<String> =
        setOf("edit", "write", "multiedit", "str_replace", "str_replace_editor", "apply_patch")

    /** Shell tools can touch anything on disk, including files pi never named. */
    private val PROCESS_TOOLS: Set<String> = setOf("bash", "powershell")

    private val REFRESH_TOOLS: Set<String> = EDIT_TOOLS + PROCESS_TOOLS

    /** Argument keys pi's tools use for the target path (frontend `filePathOf` rule). */
    private val PATH_KEYS = listOf("path", "file_path", "file")

    fun shouldRefresh(toolName: String): Boolean = toolName.lowercase() in REFRESH_TOOLS

    /**
     * Paths to refresh for one tool event, or `null` for a whole-project
     * refresh (shell tools, or a write tool without a usable path argument).
     * An empty list means "no refresh" (read-only tools).
     */
    fun pathsForEvent(toolName: String, args: JsonObject?): List<String>? {
        if (!shouldRefresh(toolName)) return emptyList()
        if (args == null) return null
        val path = PATH_KEYS.asSequence()
            .mapNotNull { key -> (args[key] as? kotlinx.serialization.json.JsonPrimitive)?.content }
            .firstOrNull { it.isNotBlank() }
            ?: return null
        return listOf(path)
    }
}
