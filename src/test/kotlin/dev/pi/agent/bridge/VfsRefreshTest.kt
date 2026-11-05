package dev.pi.agent.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import dev.pi.agent.bridge.VfsRefresh.pathsForEvent
import dev.pi.agent.bridge.VfsRefresh.shouldRefresh
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure parts of VFS refresh (spec 009 US4 / FR-011…FR-014): which pi tool
 * events refresh, and which paths they touch. `null` = whole-project refresh,
 * empty list = no refresh at all.
 */
class VfsRefreshTest {

    private fun args(json: String): JsonObject = Json.parseToJsonElement(json).let { it as JsonObject }

    // -- shouldRefresh --------------------------------------------------------

    @Test
    fun `write tools request a refresh`() {
        for (tool in listOf("write", "edit", "multiedit", "str_replace", "str_replace_editor", "apply_patch", "bash", "powershell")) {
            assertTrue(shouldRefresh(tool), "$tool must refresh")
            assertTrue(shouldRefresh(tool.uppercase()), "tool names are matched case-insensitively")
        }
    }

    @Test
    fun `read-only tools never refresh`() {
        for (tool in listOf("read", "grep", "glob", "ls")) {
            assertEquals(false, shouldRefresh(tool), "$tool must not refresh")
        }
    }

    // -- pathsForEvent --------------------------------------------------------

    @Test
    fun `write with a path returns that path`() {
        assertEquals(listOf("src/A.kt"), pathsForEvent("write", args("""{"path":"src/A.kt"}""")))
    }

    @Test
    fun `edit reads file_path`() {
        assertEquals(listOf("src/B.kt"), pathsForEvent("edit", args("""{"file_path":"src/B.kt"}""")))
    }

    @Test
    fun `write reads the generic file key`() {
        assertEquals(listOf("C.txt"), pathsForEvent("write", args("""{"file":"C.txt"}""")))
    }

    @Test
    fun `bash without a path means whole-project refresh`() {
        assertNull(pathsForEvent("bash", args("""{"command":"rm -rf build"}""")))
    }

    @Test
    fun `read-only tools return no refresh even with a path`() {
        assertEquals(emptyList(), pathsForEvent("read", args("""{"path":"src/A.kt"}""")))
        assertEquals(emptyList(), pathsForEvent("grep", args("""{"path":"src"}""")))
    }

    @Test
    fun `write tool with no path argument means whole-project refresh`() {
        assertNull(pathsForEvent("bash", null))
        assertNull(pathsForEvent("write", args("""{}""")))
    }

    @Test
    fun `blank path values are ignored`() {
        assertNull(pathsForEvent("write", args("""{"path":""}""")))
    }
}
