package dev.pi.agent.bridge

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * How many tool calls may be in flight before the oldest one is dropped
 * (issue #9). A call whose end never arrives must not leak.
 */
private const val MAX_IN_FLIGHT_TOOL_ARGS = 64

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

    /**
     * Tools that never change a file on disk. A tool outside both this set
     * and [REFRESH_TOOLS] is an extension tool: we cannot know what it wrote,
     * so the whole project has to be refreshed (see [planForToolCall]).
     */
    private val READ_ONLY_TOOLS: Set<String> = setOf("read", "grep", "glob", "ls")

    /** Argument keys pi's tools use for the target path (frontend `filePathOf` rule). */
    private val PATH_KEYS = listOf("path", "file_path", "file")

    /**
     * The tool arguments of the calls in flight, keyed by their call id.
     *
     * pi sends a tool's arguments with the START of the call and not with its
     * END, so the plugin has to remember them until the call finishes
     * (issue #9). Two properties matter:
     *
     *  - **FIFO eviction**: when more calls are in flight than the cap allows,
     *    the OLDEST one is dropped. A plain HashMap would drop an ARBITRARY
     *    one, and the dropped call's end event would then find no arguments —
     *    which escalates that one edit back to a whole-project refresh, i.e.
     *    exactly the flash issue #9 removed.
     *  - **bounded**: a call whose end never arrives must not leak.
     *
     * Pure and platform-free, so the eviction order is unit-testable.
     */
    class InFlightToolArgs(private val maxEntries: Int = MAX_IN_FLIGHT_TOOL_ARGS) {

        /** Insertion-ordered, so the first key is the oldest call. */
        private val byCallId = LinkedHashMap<String, JsonObject?>()

        /**
         * Remembers a call's arguments, dropping the oldest call when the cap
         * is reached.
         */
        @Synchronized
        fun remember(callId: String, args: JsonObject?) {
            byCallId[callId] = args
            while (byCallId.size > maxEntries) {
                val oldest = byCallId.keys.firstOrNull() ?: break
                byCallId.remove(oldest)
            }
        }

        /**
         * Takes a call's arguments back.
         *
         * Null when the call is unknown — either it was never seen, or it was
         * evicted, or it carried no arguments at all. The caller cannot tell
         * those apart, and does not have to: all three mean "no path here".
         */
        @Synchronized
        fun take(callId: String): JsonObject? = byCallId.remove(callId)

        /** How many calls are being tracked right now. */
        @Synchronized
        fun size(): Int = byCallId.size
    }

    /**
     * What one refresh does.
     *
     * @param whole refresh the whole project tree — the escape hatch for tools
     *   that cannot name the files they touched.
     * @param paths the concrete files to refresh, each recursively. Empty when
     *   [whole] is set.
     */
    data class RefreshPlan(
        val whole: Boolean,
        val paths: List<String>,
    ) {
        /** Nothing to refresh. */
        val isEmpty: Boolean get() = !whole && paths.isEmpty()

        companion object {
            /** No file changed that the IDE needs to know about. */
            val NONE = RefreshPlan(whole = false, paths = emptyList())

            /** The whole project tree has to be refreshed. */
            val WHOLE = RefreshPlan(whole = true, paths = emptyList())
        }
    }

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
            .mapNotNull { key -> (args[key] as? JsonPrimitive)?.content }
            .firstOrNull { it.isNotBlank() }
            ?: return null
        return listOf(path)
    }

    /**
     * What one tool call means for the VFS (issue #9).
     *
     * - an edit-class tool that named its file → exactly that file, never the
     *   whole tree. Refreshing the whole tree is what reloaded the document
     *   the user was editing and made the IDE flash.
     * - a tool that cannot name the files it touched (bash) → the whole tree
     * - a read-only tool → nothing
     * - an extension tool we know nothing about → the whole tree: only then
     *   can we be sure the working tree is untouched
     */
    fun planForToolCall(toolName: String, args: JsonObject?): RefreshPlan {
        val tool = toolName.lowercase()
        if (tool in READ_ONLY_TOOLS) return RefreshPlan.NONE
        if (tool in REFRESH_TOOLS) {
            val paths = pathsForEvent(tool, args) ?: return RefreshPlan.WHOLE
            return if (paths.isEmpty()) RefreshPlan.NONE else RefreshPlan(whole = false, paths = paths)
        }
        return RefreshPlan.WHOLE
    }

    /**
     * What a finished round of tool calls means for the VFS (issue #9).
     *
     * The files the round named are refreshed exactly; the whole tree is only
     * refreshed when a tool could not name the files it touched.
     */
    fun planForRound(paths: Collection<String>, needsWhole: Boolean): RefreshPlan =
        if (needsWhole) RefreshPlan.WHOLE
        else if (paths.isEmpty()) RefreshPlan.NONE
        else RefreshPlan(whole = false, paths = paths.distinct())

    /**
     * The refresh targets for a whole-project refresh that must leave
     * [excludedPath] alone (issue #9).
     *
     * Refreshing the whole tree re-reads every file in it, and the document
     * the user is editing is reloaded with it — the caret jumps and the IDE
     * flashes. The tree is therefore walked down the path to the excluded
     * file: at every level the siblings are refreshed and the element on the
     * path is descended into, so the excluded file is the only thing in the
     * tree that is not refreshed.
     *
     * The directories on the path are refreshed WITHOUT recursion — their
     * listing still has to be re-read (bash may have created a file in them)
     * but their contents must not be re-read.
     *
     * [listChildren] enumerates the entries of a directory.
     */
    fun wholeRefreshTargets(
        root: String,
        excludedPath: String?,
        listChildren: (String) -> List<String>,
    ): WholeRefreshPlan {
        val normalizedRoot = normalizeSlashes(root).trimEnd('/')
        val excluded = excludedPath?.let { normalizeSlashes(it).trimEnd('/') }
        if (excluded == null || !isUnder(excluded, normalizedRoot)) {
            return WholeRefreshPlan(deep = listOf(normalizedRoot), shallow = emptyList())
        }
        val segments = excluded.removePrefix(normalizedRoot + "/").split('/')
        val deep = LinkedHashSet<String>()
        val shallow = LinkedHashSet<String>()
        var dir = normalizedRoot
        for (segment in segments) {
            val onThePath = dir + "/" + segment
            for (child in listChildren(dir)) {
                val childPath = normalizeSlashes(child).trimEnd('/')
                // The element on the path to the excluded file is descended
                // into instead of refreshed: refreshing it would take the
                // excluded file with it.
                if (childPath.equals(onThePath, ignoreCase = true)) continue
                deep.add(childPath)
            }
            // The last segment is the excluded file itself — its directory is
            // the deepest one that is still refreshed, but only shallowly.
            if (segment != segments.last()) shallow.add(dir)
            dir = onThePath
        }
        shallow.add(dir.substringBeforeLast('/'))
        return WholeRefreshPlan(deep = deep.toList(), shallow = shallow.toList())
    }

    /**
     * The targets of a whole-project refresh.
     *
     * @param deep refreshed recursively — the bulk of the tree.
     * @param shallow refreshed without recursion — the directories on the way
     *   to the excluded file, whose listing has to be re-read.
     */
    data class WholeRefreshPlan(
        val deep: List<String>,
        val shallow: List<String>,
    )

    /** True when [path] is [root] itself or below it. */
    private fun isUnder(path: String, root: String): Boolean =
        path.equals(root, ignoreCase = true) ||
            path.startsWith(root + "/", ignoreCase = true)

    private fun normalizeSlashes(path: String): String = path.replace('\\', '/')
}
