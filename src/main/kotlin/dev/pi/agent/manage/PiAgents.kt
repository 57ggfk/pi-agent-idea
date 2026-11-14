package dev.pi.agent.manage

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

/**
 * AGENTS.md management (012 US3, T115–T117).
 *
 * pi loads context files from the global agent dir AND every ancestor of the
 * working directory, concatenating them — measured in 012 T102 (see plan D4):
 * per directory the first existing candidate of
 * `AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD` wins.
 * The plugin mirrors exactly that algorithm for its panel; it never parses
 * file contents (plan D4 hard constraint 2) — editing happens in the IDE
 * editor, creation writes a template.
 */
object PiAgents {

    /** Per-directory candidate order, from pi's `loadProjectContextFiles`. */
    val CANDIDATES: List<String> =
        listOf("AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD")

    /** Bounded scan (plan D4 constraint 1): these never contribute entries. */
    private val SKIPPED_DIRS: Set<String> = setOf(
        "node_modules", ".git", ".svn", ".hg", "dist", "build", "target", "out", ".idea", ".gradle",
    )

    private const val MAX_DEPTH = 6
    private const val MAX_ENTRIES = 100

    /** The file pi would load from [dir], and whether it exists. */
    data class Effective(val file: File?, val candidate: String, val exists: Boolean)

    fun effectiveIn(dir: File): Effective {
        for (name in CANDIDATES) {
            val f = File(dir, name)
            if (f.isFile) return Effective(f, name, true)
        }
        return Effective(null, "AGENTS.md", false)
    }

    /**
     * Every context-file location pi would read for [projectPath]: one global
     * row (agentDir), one project-root row (always present, even without a
     * file, so "create" has a target), and one row per subdirectory that
     * already carries a candidate file. Order = pi's load order: global
     * first, then root, then subdirectories shallower-first (T102 table).
     */
    fun list(projectPath: String?): JsonObject {
        val entries = mutableListOf<JsonObject>()

        val agentDir = PiCliRunner.agentDir()
        val userHome = File(System.getProperty("user.home"))
        entries.add(entryJson(scope = "global", dir = agentDir, relative = null, priority = 0, userHome = userHome))

        if (projectPath != null) {
            val root = File(projectPath)
            if (root.isDirectory) {
                entries.add(entryJson(scope = "root", dir = root, relative = null, priority = 1, userHome = userHome))

                var count = 0
                root.walkTopDown().onEnter { dir ->
                    // Bounded: skip VCS/build dirs and stop at the caps.
                    dir.name !in SKIPPED_DIRS && dir.depth(root) <= MAX_DEPTH && count < MAX_ENTRIES
                }.forEach { dir ->
                    if (dir == root) return@forEach
                    if (count >= MAX_ENTRIES) return@forEach
                    val eff = effectiveIn(dir)
                    if (eff.exists) {
                        count++
                        entries.add(
                            entryJson(
                                scope = "subdirectory",
                                dir = dir,
                                relative = dir.relativeToOrNull(root)?.invariantSeparatorsPath,
                                priority = 1 + dir.depth(root),
                                userHome = userHome,
                            ),
                        )
                    }
                }
            }
        }

        return buildJsonObject {
            put("ok", true)
            put("agentDir", agentDir.absolutePath)
            put("candidates", kotlinx.serialization.json.JsonArray(CANDIDATES.map { kotlinx.serialization.json.JsonPrimitive(it) }))
            put("entries", kotlinx.serialization.json.JsonArray(entries))
        }
    }

    private fun File.depth(root: File): Int =
        relativeToOrNull(root)?.path?.count { it == File.separatorChar }?.plus(1) ?: 1

    private fun entryJson(scope: String, dir: File, relative: String?, priority: Int, userHome: File): JsonObject {
        val eff = effectiveIn(dir)
        val candidate = eff.candidate
        // T1509: short display form — global entries under the agent dir
        // collapse to `~`; root/subdirectory entries are project-relative.
        val displayPath = when (scope) {
            "global" -> displayShort(dir, userHome) + "/" + candidate
            else -> (relative?.takeIf { it.isNotEmpty() }?.plus("/") ?: "") + candidate
        }
        return buildJsonObject {
            put("scope", scope)
            put("dir", dir.absolutePath)
            put("relativePath", relative ?: "")
            put("fileName", candidate)
            put("path", (eff.file ?: File(dir, eff.candidate)).absolutePath)
            put("displayPath", displayPath)
            put("exists", eff.exists)
            put("priority", priority)
        }
    }

    /** `~`-short form for dirs under the user home (034 T1509); else the full path. */
    private fun displayShort(dir: File, userHome: File): String {
        val d = dir.absolutePath.replace('\\', '/')
        val home = userHome.absolutePath.replace('\\', '/')
        return if (d.startsWith(home)) "~" + d.substring(home.length) else d
    }

    /**
     * Opens an entry in the IDE editor (T116). Only paths the list itself
     * produced are accepted — an arbitrary path would turn the panel into a
     * file-open dialog for any file on disk. [project] is nullable so the
     * validation logic runs without the platform (unit tests).
     */
    fun open(project: Project?, basePath: String?, params: JsonObject): JsonObject {
        val path = params.string("path") ?: return error("missing path")
        val file = File(path)
        if (!isAllowedPath(file, basePath)) return error("path is not an AGENTS.md location: $path")
        if (!file.isFile) return error("file does not exist: $path")
        if (project != null) {
            val vf = LocalFileSystem.getInstance().findFileByIoFile(file)
                ?: throw IllegalStateException("file not found in VFS: $path")
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                com.intellij.openapi.fileEditor.OpenFileDescriptor(project, vf, 0, 0).navigate(true)
            }
        }
        return buildJsonObject {
            put("ok", true)
            put("path", file.absolutePath)
        }
    }

    /**
     * Creates a context file from a template (T117): UTF-8, `mkdirs`,
     * idempotent — creating twice leaves one file with the original content.
     */
    fun create(basePath: String?, params: JsonObject): JsonObject {
        val path = params.string("path") ?: return error("missing path")
        val file = File(path)
        if (!isAllowedPath(file, basePath)) return error("path is not an AGENTS.md location: $path")
        if (file.name !in CANDIDATES) return error("not a context-file name: ${file.name}")
        if (file.isFile) {
            return buildJsonObject { put("ok", true); put("path", file.absolutePath); put("created", false) }
        }
        val template =
            "# AGENTS.md\n\nInstructions for pi in this directory. " +
                "Loaded together with the global ~/.pi/agent/AGENTS.md (if present); " +
                "closer files are appended after broader ones.\n"
        return try {
            file.parentFile?.mkdirs()
            file.writeText(template, Charsets.UTF_8)
            refreshVfs(file)
            buildJsonObject { put("ok", true); put("path", file.absolutePath); put("created", true) }
        } catch (e: Exception) {
            error("could not create ${file.name}: ${e.message}")
        }
    }

    /** VFS refresh so the IDE editor sees a new file immediately; a no-op
     *  outside the IDE (plain unit tests have no Application). */
    private fun refreshVfs(file: File) {
        val app = com.intellij.openapi.application.ApplicationManager.getApplication() ?: return
        app.invokeLater {
            VirtualFileManager.getInstance().asyncRefresh {
                LocalFileSystem.getInstance().findFileByIoFile(file)
            }
        }
    }

    /** Paths a panel action may touch: the global dir plus the project tree. */
    private fun isAllowedPath(file: File, basePath: String?): Boolean {
        val roots = buildList {
            add(PiCliRunner.agentDir())
            basePath?.takeIf { it.isNotBlank() }?.let { add(File(it)) }
        }
        return roots.any { root ->
            runCatching { file.canonicalPath == root.canonicalPath || file.canonicalPath.startsWith(root.canonicalPath + File.separator) }
                .getOrDefault(false)
        }
    }

    private fun error(message: String): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", message)
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
}
