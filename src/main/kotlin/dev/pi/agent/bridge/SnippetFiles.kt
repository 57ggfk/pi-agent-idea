package dev.pi.agent.bridge

import com.intellij.lang.Language
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.testFramework.LightVirtualFile

/**
 * 041: in-memory snippet files for "open this code block in the IDE".
 * Everything here stays in memory (Q3: LightVirtualFile, read-only, thrown
 * away when the tab closes) — the alias table is the only part with real
 * logic, so it is extracted for unit testing.
 */
object SnippetFiles {

    /** `language-xxx` fence id → IDE language id. null = no confident mapping. */
    fun ideLanguageId(raw: String): String? = when (raw.lowercase()) {
        "js", "jsx", "mjs", "cjs", "node" -> "JavaScript"
        "ts", "tsx" -> "TypeScript"
        "py", "python" -> "Python"
        "kt", "kotlin" -> "kotlin"
        "java" -> "JAVA"
        "sh", "bash", "zsh", "shell" -> "shell"
        "c" -> "C"
        "cpp", "c++" -> "C++"
        "cs", "csharp" -> "C#"
        "go" -> "go"
        "rb", "ruby" -> "ruby"
        "rs", "rust" -> "Rust"
        "swift" -> "Swift"
        "php" -> "PHP"
        "sql" -> "SQL"
        "json" -> "JSON"
        "yaml", "yml" -> "yaml"
        "toml" -> "toml"
        "xml" -> "XML"
        "html" -> "HTML"
        "css" -> "CSS"
        "md", "markdown" -> "Markdown"
        "diff", "patch" -> "DIFF"
        "gradle", "groovy" -> "Groovy"
        "properties" -> "Properties"
        else -> null
    }

    /** File extension for the in-memory name (drives IDE's file-type pick). */
    fun extensionFor(raw: String): String = when (raw.lowercase()) {
        "js", "jsx", "mjs", "cjs", "node" -> "js"
        "ts", "tsx" -> "ts"
        "py", "python" -> "py"
        "kt", "kotlin" -> "kt"
        "java" -> "java"
        "sh", "bash", "zsh", "shell" -> "sh"
        "c", "h" -> "c"
        "cpp", "c++", "hpp" -> "cpp"
        "cs", "csharp" -> "cs"
        "go" -> "go"
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
        "md", "markdown" -> "md"
        "diff", "patch" -> "diff"
        "gradle", "groovy" -> "gradle"
        "properties" -> "properties"
        else -> raw.takeIf { Regex("[a-z0-9]{1,12}").matches(it) } ?: "txt"
    }

    /**
     * Builds the read-only in-memory file for a snippet. Resolution order:
     * alias table → raw id as a language id → file-type-by-name → plain text
     * (041 US2: an unknown language opens fine as plain text, never throws).
     */
    fun buildVirtualFile(raw: String, text: String, seq: Int): LightVirtualFile {
        val mapped = ideLanguageId(raw) ?: raw.takeIf { it.isNotBlank() }
        val language = mapped?.let { Language.findLanguageByID(it) }
        val fileType = language?.associatedFileType
            ?: mapped?.let { FileTypeManager.getInstance().findFileTypeByName(it) }
            ?: PlainTextFileType.INSTANCE
        val vf = LightVirtualFile("pi-snippet-$seq.${extensionFor(raw)}", fileType, text)
        vf.isWritable = false
        return vf
    }
}
