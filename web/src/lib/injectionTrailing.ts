/**
 * 045: the unified trailing rule for everything injected into the composer
 * (paste-fold chips, editor quote, file references, dragged text). Multi-line
 * content ends with exactly one newline; single-line content ends with two
 * spaces (Markdown hard break). Content that already carries the equivalent
 * trailing is never stacked (FR-003) — existing trailing whitespace is
 * trimmed first so the result is canonical, but whitespace inside the content
 * is never touched.
 */

/** `content` + its canonical trailing. */
export function injectionTrailing(content: string): string {
  // Multi-line is decided on the ORIGINAL content: "x\n" already carries the
  // multi-line trailing and must stay "x\n", not degrade to two spaces.
  const multiLine = content.includes("\n");
  const trimmed = content.replace(/\s+$/, "");
  return multiLine ? `${trimmed}\n` : `${trimmed}  `;
}

/**
 * The trailing that follows a clean token standing in for `content` (the 044
 * fold chip): the token itself carries no whitespace, so the rule applies to
 * the ORIGINAL content — multi-line paste → newline, single-line → two spaces.
 */
export function trailingFor(content: string): string {
  return content.includes("\n") ? "\n" : "  ";
}
