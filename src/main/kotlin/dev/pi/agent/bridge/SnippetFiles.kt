package dev.pi.agent.bridge

import com.intellij.lang.Language
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.testFramework.LightVirtualFile

/**
 * 041: in-memory snippet files for "open this code block in the IDE".
 * Everything here stays in memory (Q3: LightVirtualFile, read-only, thrown
 * away when the tab closes) — the alias table is the only part with real
 * logic, so it is extracted for unit testing.
 *
 * A snippet's content comes from `code.textContent`: it is text by
 * construction. The file type attached to it is therefore ours to choose,
 * and it must never be a binary one — the IDE opens a binary file with the
 * large-file viewer, which has no focusable component, so the editor closes
 * the tab again at once and the user sees nothing at all (real machine,
 * 2026-11-23: a ```lua block opened and vanished in 10ms; every fence id
 * whose extension the IDE does not register behaved the same). An unknown
 * language degrades to plain text (041 US2); it never degrades to "nothing".
 *
 * A file link is the other story and does NOT come through here: that file
 * lives on disk and its own type decides (a PNG opens in the image viewer, a
 * .jar in the archive viewer). Forcing plain text there would corrupt what
 * the user asked to see — so the two paths keep different rules on purpose.
 */
object SnippetFiles {

    /** `language-xxx` fence id → IDE language id. null = no confident mapping. */
    fun ideLanguageId(raw: String): String? = when (raw.lowercase()) {
        "js", "jsx", "mjs", "cjs", "node" -> "JavaScript"
        "ts", "tsx" -> "TypeScript"
        "py", "python", "python3" -> "Python"
        "kt", "kotlin" -> "kotlin"
        "java" -> "JAVA"
        // 2026-11-23: the IDE language id is "Shell Script", not "shell" —
        // "shell" never matched a language, so every shell block fell
        // through to the extension lookup and then to plain text.
        "sh", "bash", "zsh", "shell", "shell-script" -> "Shell Script"
        "c" -> "C"
        "cpp", "c++" -> "C++"
        "cs", "csharp" -> "C#"
        "go", "golang" -> "Go"
        "rb", "ruby" -> "Ruby"
        "rs", "rust" -> "Rust"
        "swift" -> "Swift"
        "php" -> "PHP"
        "sql" -> "SQL"
        "json" -> "JSON"
        "yaml", "yml" -> "yaml"
        "toml" -> "TOML"
        "xml" -> "XML"
        "html" -> "HTML"
        "css" -> "CSS"
        "scss" -> "SCSS"
        "sass" -> "SASS"
        "less" -> "LESS"
        "md", "markdown" -> "Markdown"
        "diff", "patch" -> "DIFF"
        "gradle", "groovy" -> "Groovy"
        "properties" -> "Properties"
        "vue" -> "Vue.js"
        "text", "plaintext", "txt" -> "Plain Text"
        else -> null
    }

    /** File extension for the in-memory name (drives IDE's file-type pick). */
    fun extensionFor(raw: String): String = when (raw.lowercase()) {
        "js", "jsx", "mjs", "cjs", "node" -> "js"
        "ts", "tsx" -> "ts"
        "py", "python", "python3" -> "py"
        "kt", "kotlin" -> "kt"
        "java" -> "java"
        "sh", "bash", "zsh", "shell", "shell-script" -> "sh"
        "c", "h" -> "c"
        "cpp", "c++", "hpp" -> "cpp"
        "cs", "csharp" -> "cs"
        "go", "golang" -> "go"
        "rb", "ruby" -> "rb"
        "rs", "rust" -> "rs"
        "swift" -> "swift"
        "php" -> "php"
        "sql" -> "sql"
        "json" -> "json"
        "yaml", "yml" -> "yaml"
        "toml" -> "toml"
        "xml" -> "xml"
        "html" -> "html"
        "css" -> "css"
        "scss" -> "scss"
        "sass" -> "sass"
        "less" -> "less"
        "md", "markdown" -> "md"
        "diff", "patch" -> "diff"
        "gradle", "groovy" -> "gradle"
        "properties" -> "properties"
        "vue" -> "vue"
        "text", "plaintext", "txt" -> "txt"
        else -> raw.takeIf { Regex("[a-z0-9]{1,12}").matches(it) } ?: "txt"
    }

    /**
     * The IDE language ids to try for a fence id, best first: the alias
     * table's answer, then the raw id.
     *
     * The raw id is what keeps this table short — a fence id that happens
     * to be an IDE language id ("lua", "dart", "scala", "objective-c") then
     * resolves on its own, with or without the matching plugin installed.
     */
    fun languageCandidates(raw: String): List<String> {
        val out = LinkedHashSet<String>()
        ideLanguageId(raw)?.let { out.add(it) }
        raw.trim().takeIf { it.isNotEmpty() }?.let { out.add(it) }
        return out.toList()
    }

    /**
     * The first candidate the IDE can show as text.
     *
     * A binary file type is skipped: the IDE opens a binary file with the
     * large-file viewer, which has no focusable component — the editor
     * closes the tab again at once, so the user sees nothing at all. null
     * means "no textual candidate"; the caller then falls back to plain
     * text, which is always safe for a snippet.
     *
     * Pure on purpose: the platform lookup stays outside, so the rule that
     * broke (a binary type sneaking in) can be unit-tested without an IDE.
     */
    fun <T> firstTextual(candidates: List<T>, isBinary: (T) -> Boolean): T? =
        candidates.firstOrNull { !isBinary(it) }

    /**
     * The file type a fence id maps to. Never binary.
     *
     * Resolution order: the IDE language behind the fence id → the file type
     * with that name → the file type registered for the extension → plain
     * text. The extension lookup is the last *candidate*, not the last
     * word: `getFileTypeByExtension` answers `UnknownFileType.INSTANCE`
     * for an extension the IDE does not know, and that type is BINARY — the
     * very reason the tab used to disappear.
     */
    fun resolveFileType(raw: String): FileType {
        val fileTypes = FileTypeManager.getInstance()
        val byLanguage = languageCandidates(raw).mapNotNull { id ->
            findLanguage(id)?.associatedFileType ?: fileTypes.findFileTypeByName(id)
        }
        val byExtension = fileTypes.getFileTypeByExtension(extensionFor(raw))
        return firstTextual(byLanguage + byExtension) { it.isBinary } ?: PlainTextFileType.INSTANCE
    }

    /**
     * Looks a language up by id, case-insensitively: the fence id and the
     * IDE language id often differ only in case ("go" vs "Go").
     */
    private fun findLanguage(id: String): Language? =
        Language.findLanguageByID(id)
            ?: Language.getRegisteredLanguages().firstOrNull { it.id.equals(id, ignoreCase = true) }

    /**
     * Builds the read-only in-memory file for a snippet. The name keeps the
     * fence id as its extension, so the tab still says what the block was
     * ("pi-snippet-3.lua") even when it opens as plain text.
     */
    fun buildVirtualFile(raw: String, text: String, seq: Int): LightVirtualFile {
        val vf = LightVirtualFile("pi-snippet-$seq.${extensionFor(raw)}", resolveFileType(raw), text)
        vf.isWritable = false
        return vf
    }
}
