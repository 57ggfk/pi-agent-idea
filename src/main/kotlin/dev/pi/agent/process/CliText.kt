package dev.pi.agent.process

/**
 * Cleaning pass for CLI text that reaches the UI (011 T020).
 *
 * `drainThread` already decodes bytes correctly; this layer removes what a
 * terminal would render but a result banner must not carry: ANSI escape
 * sequences, carriage-return progress frames and backspace overwrites. Plain
 * text — including `[`, Chinese and newlines — passes through byte-for-byte.
 */
object CliText {

    /** CSI sequences: `ESC [ params intermediates final`. */
    private val CSI = Regex("\u001B\\[[0-9;?<=>]*[ -/]*[@-~]")

    /** OSC sequences: `ESC ] ... BEL` or `ESC ] ... ST (ESC \)`. */
    private val OSC = Regex("\u001B\\][^\u0007\u001B]*(?:\u0007|\u001B\\\\)")

    /** Stray single-char escapes that carry no payload worth keeping. */
    private val ESC = Regex("\u001B[@-Z\\-_]")

    /**
     * Terminal-visible text only. A `\r` rewinds the cursor to the line start,
     * so within one line the **last** non-empty segment wins (a progress bar
     * leaves its final frame, e.g. `10%\r50%\rdone` → `done`); `\b` deletes
     * the character before it. Everything else is untouched.
     */
    fun sanitizeCliOutput(text: String): String {
        if (!text.contains('\u001B') && !text.contains('\r') && !text.contains('\b')) return text
        val noAnsi = text.replace(CSI, "").replace(OSC, "").replace(ESC, "")
        return noAnsi.split('\n').joinToString("\n") { line ->
            // Last \r segment that actually shows something; a trailing \r
            // with an empty final frame clears the line, matching the terminal.
            var s = line.substringAfterLast('\r')
            if (s.contains('\b')) {
                val sb = StringBuilder(s.length)
                for (ch in s) {
                    if (ch == '\b') {
                        if (sb.isNotEmpty()) sb.setLength(sb.length - 1)
                    } else {
                        sb.append(ch)
                    }
                }
                s = sb.toString()
            }
            s
        }
    }

    /**
     * Truncates to [max] **code points** (never inside a surrogate pair) and
     * marks the cut with `…`. Idempotent for text at or under [max].
     */
    fun safeTruncate(text: String, max: Int): String {
        if (max <= 0) return ""
        if (text.codePointCount(0, text.length) <= max) return text
        val cut = text.offsetByCodePoints(0, max)
        return text.substring(0, cut) + "…"
    }
}
