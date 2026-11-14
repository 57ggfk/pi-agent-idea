package dev.pi.agent.manage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

/**
 * Skills management plumbing (spec 034): six-source discovery with per-source
 * attribution, the hard enable/disable switch (settings.json `skills` array
 * exclusion entries — probe-verified `-exact` and `!glob` forms, bare names
 * do NOT work), external skill sources (the Claude/Codex bridge: pi does not
 * read `~/.claude/skills` natively, but the settings array accepts any
 * directory) and the soft per-skill `disable-model-invocation` frontmatter
 * toggle.
 *
 * Everything file-shaped here is injectable so tests drive it from temp dirs
 * without a pi install.
 */
object PiSkills {

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }

    // -- discovery (FR-001) ----------------------------------------------------

    /** One discovered skill, as the bridge returns it. */
    data class Entry(
        val name: String,
        val description: String,
        val path: String,
        /** Shortened for display (T1507): `~` for home, project-relative for project skills. */
        val displayPath: String,
        val scope: String,
        val source: String,
        val disableModelInvocation: Boolean,
        val enabled: Boolean,
        val duplicate: Boolean,
    )

    data class Listing(
        val entries: List<Entry>,
        val externalSources: List<String>,
        val claudeDir: String,
        val codexDir: String,
        /** Real home dir, so the UI can shorten external preset labels to `~`. */
        val homeDir: String,
    )

    /**
     * Scans every source with attribution. `~/.agents/skills` resolves from
     * the **real** user home — probe-verified: it is NOT affected by
     * PI_CODING_AGENT_DIR, unlike `<agent>/skills`. Project `.agents/skills`
     * walks ancestors up to the repo root (pi semantics). Package skills
     * resolve from the settings `packages` arrays. Project sources are listed
     * regardless of trust — pi ignores them until trusted, and the panel
     * marks that state (002 semantics), so here trust is only a write gate.
     */
    fun list(agentDir: File, userHome: File, projectBasePath: String?): Listing {
        val userSettingsFile = File(agentDir, "settings.json")
        val userSettings = readSettings(userSettingsFile)
        val projectSettingsFile = projectBasePath?.takeIf { it.isNotBlank() }
            ?.let { File(File(it, ".pi"), "settings.json") }
        val projectSettings = projectSettingsFile?.let(::readSettings)

        val exclusions = collectExclusions(listOfNotNull(userSettings, projectSettings))
        val externalDirs = positiveDirEntries(userSettings)

        data class Source(val dir: File, val source: String, val scope: String)
        val sources = buildList {
            add(Source(File(agentDir, "skills"), "user-pi", "user"))
            add(Source(File(userHome, ".agents/skills"), "user-agents", "user"))
            if (projectBasePath?.isNotBlank() == true) {
                val base = File(projectBasePath)
                add(Source(File(base, ".pi/skills"), "project-pi", "project"))
                ancestorAgentDirs(base).forEach { add(Source(it, "project-agents", "project")) }
                packageDirs(projectSettings, null, agentDir).forEach {
                    add(Source(it, "package", "project"))
                }
            }
            packageDirs(userSettings, userSettingsFile.parentFile, agentDir).forEach {
                add(Source(it, "package", "user"))
            }
            externalDirs.forEach { add(Source(File(it), "external", "user")) }
        }

        val skills = mutableListOf<Entry>()
        val seen = mutableSetOf<String>()
        val nameSeen = mutableSetOf<String>()
        for (source in sources) {
            if (!source.dir.isDirectory) continue
            val files = mutableListOf<File>()
            source.dir.walkTopDown()
                .filter { it.name == "SKILL.md" && it.isFile }
                .forEach { file ->
                    val key = runCatching { file.canonicalPath }.getOrElse { file.absolutePath }
                    if (seen.add(key)) files += file
                }
            for (file in files) {
                val front = PiManage.parseFrontmatter(file)
                val name = front["name"] ?: file.parentFile.name
                val skillPath = normalizePath(file.parentFile.absolutePath)
                skills += Entry(
                    name = name,
                    description = front["description"] ?: "",
                    path = file.parentFile.absolutePath,
                    displayPath = displayPathOf(skillPath, source.source, source.dir, userHome, agentDir, projectBasePath),
                    scope = source.scope,
                    source = source.source,
                    disableModelInvocation = front["disable-model-invocation"] == "true",
                    enabled = exclusions.none { exclusionMatches(it, skillPath) },
                    duplicate = !nameSeen.add(name),
                )
            }
        }
        return Listing(
            entries = skills,
            externalSources = externalDirs,
            claudeDir = normalizePath(File(userHome, ".claude/skills").absolutePath),
            codexDir = normalizePath(File(userHome, ".codex/skills").absolutePath),
            homeDir = normalizePath(userHome.absolutePath),
        )
    }

    /**
     * Project `.agents/skills` ancestors: start at [base] and walk upward,
     * collecting every level that has `.agents/skills`, stopping **after** the
     * first directory containing `.git` (the repo root). Bounded at 10 levels.
     */
    internal fun ancestorAgentDirs(base: File): List<File> {
        val dirs = mutableListOf<File>()
        var dir: File? = base
        var levels = 0
        while (dir != null && levels < 10) {
            val agentDir = File(dir, ".agents/skills")
            if (agentDir.isDirectory) dirs += agentDir
            if (File(dir, ".git").exists()) break
            dir = dir.parentFile
            levels++
        }
        return dirs
    }

    /** npm package dirs from one settings doc's `packages` array (git skipped). */
    private fun packageDirs(settings: JsonObject?, settingsDir: File?, agentDir: File): List<File> {
        val npmDir = File(agentDir, "npm/node_modules")
        return (settings?.stringArray("packages") ?: emptyList()).mapNotNull { spec ->
            when {
                spec.startsWith("npm:") -> PiPackages.npmName(spec)?.let { File(npmDir, it) }
                spec.startsWith("./") || spec.startsWith("../") -> settingsDir?.let { File(it, spec) }
                spec.contains(':') -> null // git: / https:// — no cheap local path
                else -> File(spec).takeIf { it.isAbsolute }
            }?.takeIf { it.isDirectory }
        }
    }

    // -- exclusion matching (FR-003) ------------------------------------------

    /**
     * Whether one settings `skills` array entry excludes [skillPath] (the
     * SKILL.md parent dir, forward slashes). `-exact` matches the directory
     * or its SKILL.md file; `!glob` matches via a glob→regex translation.
     * Windows paths compare case-insensitively.
     */
    internal fun exclusionMatches(entry: String, skillPath: String): Boolean {
        val target = normalizePath(skillPath)
        return when {
            entry.startsWith("-") -> {
                val exact = normalizePath(entry.substring(1))
                exact == target || exact == "$target/SKILL.md"
            }
            entry.startsWith("!") -> globToRegex(entry.substring(1)).matches(target)
            else -> false
        }
    }

    internal fun globToRegex(glob: String): Regex {
        var pattern = glob
        // Boundary friendliness (minimatch-style): `a/**` matches `a` itself and
        // `**/beta/**` matches `…/beta` — the edge slashes become optional.
        var tail = ""
        if (pattern.endsWith("/**")) {
            pattern = pattern.removeSuffix("/**")
            tail = "(/.*)?"
        }
        var head = ""
        if (pattern.startsWith("**/")) {
            pattern = pattern.removePrefix("**/")
            head = "(.*/)?"
        }
        val sb = StringBuilder()
        var i = 0
        while (i < pattern.length) {
            when (val c = pattern[i]) {
                '*' -> if (i + 1 < pattern.length && pattern[i + 1] == '*') {
                    sb.append(".*"); i++
                } else {
                    sb.append("[^/]*")
                }
                '?' -> sb.append('.')
                else -> sb.append(Regex.escape(c.toString()))
            }
            i++
        }
        return Regex("(?i)$head$sb$tail")
    }

    internal fun normalizePath(path: String): String = path.replace('\\', '/').trimEnd('/')

    /**
     * Display shortening (T1507): `~` for anything under the real home,
     * project-relative for project skills, package-relative for package
     * skills (`<pkg>/…` from the npm prefix). The full path still travels in
     * `path` and the UI keeps it as the tooltip.
     */
    internal fun displayPathOf(
        skillPath: String,
        source: String,
        sourceDir: File,
        userHome: File,
        agentDir: File,
        projectBasePath: String?,
    ): String {
        val p = normalizePath(skillPath)
        if (source == "package") {
            val nm = normalizePath(File(agentDir, "npm/node_modules").absolutePath)
            if (p.startsWith("$nm/")) return p.substring(nm.length + 1)
        }
        if (projectBasePath?.isNotBlank() == true) {
            val base = normalizePath(File(projectBasePath).absolutePath)
            if (p.startsWith("$base/")) return p.substring(base.length + 1)
        }
        val agent = normalizePath(agentDir.absolutePath)
        if (p.startsWith("$agent/")) return "~/.pi/agent/" + p.substring(agent.length + 1)
        val home = normalizePath(userHome.absolutePath)
        if (p.startsWith("$home/")) return "~/" + p.substring(home.length + 1)
        return p
    }

    // -- settings helpers --------------------------------------------------------

    private fun readSettings(file: File): JsonObject? = try {
        if (file.isFile) json.parseToJsonElement(file.readText()) as? JsonObject else null
    } catch (_: Exception) {
        null
    }

    private fun writeSettings(file: File, settings: JsonObject) {
        file.parentFile?.mkdirs()
        file.writeText(json.encodeToString(JsonObject.serializer(), settings))
    }

    private fun skillEntries(settings: JsonObject?): JsonArray =
        settings?.get("skills") as? JsonArray ?: JsonArray(emptyList())

    private fun collectExclusions(settings: List<JsonObject?>): List<String> =
        settings.flatMap { doc ->
            skillEntries(doc).mapNotNull { (it as? JsonPrimitive)?.content }
                .filter { it.startsWith("-") || it.startsWith("!") }
        }

    /** Positive plain-directory entries of the user settings `skills` array. */
    private fun positiveDirEntries(settings: JsonObject?): List<String> =
        skillEntries(settings).mapNotNull { (it as? JsonPrimitive)?.content }
            .filter { it.isNotBlank() && !it.startsWith("-") && !it.startsWith("!") }

    private fun JsonObject.stringArray(key: String): List<String> =
        (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()

    private fun withoutKey(settings: JsonObject, key: String, replacement: JsonElement): JsonObject =
        buildJsonObject {
            settings.forEach { (k, v) -> if (k != key) put(k, v) }
            put(key, replacement)
        }

    // -- write paths (T1502) ------------------------------------------------------

    /**
     * Hard enable/disable via an exclusion entry (FR-003). Project scope
     * writes `.pi/settings.json` and refuses when the project is untrusted
     * (Q1-b); user scope writes the agent-dir settings. Exclusion effect is
     * global (both levels load), so the "already excluded" check reads both
     * docs. Existing non-string entries and unknown keys survive.
     */
    fun setEnabled(
        skillDir: String,
        enabled: Boolean,
        scope: String,
        agentDir: File,
        projectBasePath: String?,
        trusted: Boolean = true,
    ): JsonObject {
        val targetFile = when (scope) {
            "project" -> {
                if (!trusted) {
                    return buildJsonObject {
                        put("ok", false)
                        put("code", "untrusted")
                        put("error", "project is not trusted; trust it first to change project skills")
                    }
                }
                projectBasePath?.takeIf { it.isNotBlank() }
                    ?.let { File(File(it, ".pi"), "settings.json") }
                    ?: return error("missing project path")
            }
            else -> File(agentDir, "settings.json")
        }
        val skillPath = normalizePath(skillDir)
        val settings = readSettings(targetFile) ?: buildJsonObject { }
        val otherDoc = if (targetFile == File(agentDir, "settings.json")) {
            projectBasePath?.takeIf { it.isNotBlank() }?.let { readSettings(File(File(it, ".pi"), "settings.json")) }
        } else {
            readSettings(File(agentDir, "settings.json"))
        }
        val alreadyExcluded = collectExclusions(listOfNotNull(settings, otherDoc))
            .any { exclusionMatches(it, skillPath) }

        val old = skillEntries(settings)
        val updated: JsonArray = when {
            enabled -> buildJsonArray {
                old.forEach { el ->
                    val raw = (el as? JsonPrimitive)?.content
                    if (raw == null || !exclusionMatches(raw, skillPath)) add(el)
                }
            }
            alreadyExcluded -> old
            else -> buildJsonArray {
                old.forEach { add(it) }
                add(JsonPrimitive("-$skillPath/SKILL.md"))
            }
        }
        val changed = updated != old
        if (changed) {
            // An emptied skills array drops the key: `{"skills":[]}` is the
            // default and keeping it would churn every later read-modify-write.
            val cleaned = buildJsonObject { settings.forEach { (k, v) -> if (k != "skills") put(k, v) } }
            writeSettings(targetFile, if (updated.isEmpty()) cleaned else withoutKey(settings, "skills", updated))
        }
        return buildJsonObject { put("ok", true); put("changed", changed); put("enabled", enabled) }
    }

    /** External source wiring (Q2): a plain dir entry in the user settings array. */
    fun setSourceEnabled(dir: String, enabled: Boolean, agentDir: File): JsonObject {
        val normalized = normalizePath(dir)
        if (normalized.isBlank()) return error("missing dir")
        val targetFile = File(agentDir, "settings.json")
        val settings = readSettings(targetFile) ?: buildJsonObject { }
        val old = skillEntries(settings)
        val updated: JsonArray = if (enabled) {
            val present = old.any { (it as? JsonPrimitive)?.content?.let { c -> normalizePath(c) == normalized } == true }
            if (present) old
            else buildJsonArray {
                old.forEach { add(it) }
                add(JsonPrimitive(normalized))
            }
        } else {
            buildJsonArray {
                old.forEach { el ->
                    val raw = (el as? JsonPrimitive)?.content
                    if (raw == null || normalizePath(raw) != normalized) add(el)
                }
            }
        }
        val changed = updated != old
        if (changed) writeSettings(targetFile, withoutKey(settings, "skills", updated))
        return buildJsonObject { put("ok", true); put("changed", changed); put("enabled", enabled) }
    }

    /**
     * Soft per-skill switch (Q3-b): toggle `disable-model-invocation: true`
     * inside the SKILL.md frontmatter. Line-level edit; a skill without
     * frontmatter is refused rather than getting frontmatter invented.
     */
    fun toggleModelInvocation(skillDir: String, disable: Boolean): JsonObject {
        val file = File(skillDir, "SKILL.md")
        if (!file.isFile) return error("missing SKILL.md")
        val text = try {
            file.readText()
        } catch (e: Exception) {
            return error("unreadable SKILL.md: ${e.message}")
        }
        val lines = text.lines().toMutableList()
        if (lines.firstOrNull()?.trim() != "---") {
            return buildJsonObject { put("ok", false); put("code", "no-frontmatter"); put("error", "no frontmatter") }
        }
        val closeIndex = lines.drop(1).indexOfFirst { it.trim() == "---" }
        if (closeIndex < 0) {
            return buildJsonObject { put("ok", false); put("code", "no-frontmatter"); put("error", "unterminated frontmatter") }
        }
        val bodyEnd = 1 + closeIndex
        val pattern = Regex("^\\s*disable-model-invocation:\\s*(true|false)\\s*$")
        val existing = lines.withIndex().filter { it.index in 1 until bodyEnd && pattern.matches(it.value) }
        val updated: List<String> = when {
            disable && existing.isEmpty() -> {
                val copy = lines.toMutableList()
                copy.add(bodyEnd, "disable-model-invocation: true")
                copy
            }
            !disable && existing.isNotEmpty() -> lines.filterIndexed { index, _ -> index !in existing.map { it.index } }
            else -> lines
        }
        val changed = updated != lines
        if (changed) file.writeText(updated.joinToString("\n"))
        return buildJsonObject { put("ok", true); put("changed", changed); put("disable", disable) }
    }

    private fun error(message: String): JsonObject = buildJsonObject {
        put("ok", false)
        put("error", message)
    }
}
