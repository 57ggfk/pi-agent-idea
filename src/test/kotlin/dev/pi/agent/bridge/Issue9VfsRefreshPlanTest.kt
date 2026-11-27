package dev.pi.agent.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import dev.pi.agent.bridge.VfsRefresh.RefreshPlan
import dev.pi.agent.bridge.VfsRefresh.planForRound
import dev.pi.agent.bridge.VfsRefresh.planForToolCall
import dev.pi.agent.bridge.VfsRefresh.wholeRefreshTargets
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Issue #9 (spec 20261127-214747): the VFS refresh after a pi round.
 *
 * The plugin used to refresh the WHOLE project tree on every
 * `agent_settled`. That re-reads every file in the project and reloads the
 * document the user is editing — the "flash + focus loss" the issue is about.
 *
 * The rules under test:
 *  - an edit-class tool that named its file → exactly that file
 *  - a tool that cannot name its files (bash) → the whole tree (escape hatch)
 *  - a settled round that named files → those files, never the whole tree
 *  - a whole-tree refresh skips the document the user is editing
 */
class Issue9VfsRefreshPlanTest {

    private fun args(json: String): JsonObject = Json.parseToJsonElement(json).let { it as JsonObject }

    // -- planForToolCall -----------------------------------------------------

    @Test
    fun `edit tool with a path refreshes exactly that file`() {
        val plan = planForToolCall("edit", args("""{"path":"src/Main.java","edits":[]}"""))
        assertEquals(listOf("src/Main.java"), plan.paths)
        assertFalse(plan.whole, "a named file must not escalate to the whole tree")
    }

    @Test
    fun `write tool with file_path refreshes exactly that file`() {
        val plan = planForToolCall("write", args("""{"file_path":"src/A.kt","content":"x"}"""))
        assertEquals(listOf("src/A.kt"), plan.paths)
        assertFalse(plan.whole)
    }

    @Test
    fun `shell tool cannot name its files so the whole tree is refreshed`() {
        val plan = planForToolCall("bash", args("""{"command":"rm -rf build"}"""))
        assertTrue(plan.whole, "bash may touch anything → whole-project refresh")
    }

    @Test
    fun `write tool without a usable path falls back to the whole tree`() {
        assertTrue(planForToolCall("write", args("""{"content":"x"}""")).whole)
        assertTrue(planForToolCall("edit", null).whole)
    }

    @Test
    fun `read-only tools refresh nothing`() {
        for (tool in listOf("read", "grep", "glob", "ls")) {
            val plan = planForToolCall(tool, args("""{"path":"src/A.kt"}"""))
            assertTrue(plan.isEmpty, "$tool must not refresh anything")
        }
    }

    @Test
    fun `an unknown extension tool is treated as a possible writer`() {
        assertTrue(planForToolCall("mcp__something__write", args("""{"path":"x"}""")).whole)
    }

    // -- planForRound --------------------------------------------------------

    @Test
    fun `a settled round that named files refreshes those files only`() {
        val plan = planForRound(listOf("src/A.kt", "src/B.kt"), needsWhole = false)
        assertEquals(listOf("src/A.kt", "src/B.kt"), plan.paths)
        assertFalse(plan.whole, "a settled round must not escalate to the whole tree")
    }

    @Test
    fun `a settled round with a whole-tool keeps the whole-tree escape hatch`() {
        val plan = planForRound(listOf("src/A.kt"), needsWhole = true)
        assertTrue(plan.whole, "a tool that could not name its files still needs the whole tree")
    }

    @Test
    fun `a settled round without file changes refreshes nothing`() {
        assertTrue(planForRound(emptyList(), needsWhole = false).isEmpty)
    }

    @Test
    fun `duplicate paths in one round collapse`() {
        val plan = planForRound(listOf("src/A.kt", "src/A.kt"), needsWhole = false)
        assertEquals(listOf("src/A.kt"), plan.paths)
    }

    // -- wholeRefreshTargets -------------------------------------------------

    private val tree = mapOf(
        "/proj" to listOf("/proj/src", "/proj/README.md", "/proj/build"),
        "/proj/src" to listOf("/proj/src/Main.java", "/proj/src/App.java"),
    )

    private val listChildren: (String) -> List<String> = { dir -> tree[dir].orEmpty() }

    @Test
    fun `without an excluded file the whole project is refreshed`() {
        val plan = wholeRefreshTargets("/proj", null, listChildren)
        assertEquals(listOf("/proj"), plan.deep)
        assertTrue(plan.shallow.isEmpty())
    }

    @Test
    fun `the edited document is excluded but its siblings are refreshed`() {
        val plan = wholeRefreshTargets("/proj", "/proj/src/Main.java", listChildren)
        assertFalse(
            plan.deep.contains("/proj/src/Main.java"),
            "the edited document must not be refreshed",
        )
        assertTrue(plan.deep.contains("/proj/src/App.java"), "siblings still refresh")
        assertTrue(plan.deep.contains("/proj/README.md"))
        assertTrue(plan.deep.contains("/proj/build"))
    }

    @Test
    fun `the directory of the edited document is refreshed but not its contents`() {
        val plan = wholeRefreshTargets("/proj", "/proj/src/Main.java", listChildren)
        assertTrue(plan.shallow.contains("/proj/src"), "the listing of the edited file's dir still refreshes")
        assertFalse(plan.shallow.contains("/proj/src/Main.java"))
    }

    @Test
    fun `a file outside the project does not change the target set`() {
        val plan = wholeRefreshTargets("/proj", "/elsewhere/x.kt", listChildren)
        assertEquals(listOf("/proj"), plan.deep)
        assertTrue(plan.shallow.isEmpty())
    }

    @Test
    fun `the project root itself is refreshed when the excluded file is directly inside it`() {
        val plan = wholeRefreshTargets("/proj", "/proj/README.md", listChildren)
        assertFalse(plan.deep.contains("/proj/README.md"))
        assertTrue(plan.deep.contains("/proj/src"))
    }

    @Test
    fun `windows-style separators are handled`() {
        val plan = wholeRefreshTargets("C:/proj", "C:\\proj\\src\\Main.java", listChildren)
        assertFalse(plan.deep.contains("/proj/src/Main.java"))
    }
}
