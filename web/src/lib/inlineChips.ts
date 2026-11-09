/**
 * Inline reference tokens (spec 018 US1). The textarea stays the single
 * source of truth: a reference IS the text `@path` at its position, and the
 * mirror overlay merely paints a pill over each token. Sending is then just
 * the raw text — pi resolves `@` references itself (spec 015 调研 ①).
 */

export interface InlineToken {
  /** Index of the `@` character in the source text. */
  start: number;
  /** Index one past the token's last character. */
  end: number;
  /** The path without the leading `@`. */
  path: string;
}

/**
 * Same boundary rule as the composer's `AT_QUERY_RE` (spec 010-era): the `@`
 * must sit at the start of the text or after a character that cannot end a
 * word — so `看@src` works for CJK input while `user@example.com` reads as
 * an email, not as a token. Global form for tokens anywhere in the text.
 */
const TOKEN_RE = /(?:^|[^\w@])@([^\s@]+)/g;

/** Finds every `@path` token in `text`, in order. */
export function findTokens(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
    // The boundary character (or `^`) precedes the `@`; the path never
    // contains `@`, so the delimiter is the last `@` in the match.
    const at = m.index + m[0].length - 1 - m[1].length;
    out.push({ start: at, end: at + 1 + m[1].length, path: m[1] });
  }
  return out;
}

/** Removes `[start, end)` from `text` — one token's delete. */
export function removeRange(text: string, start: number, end: number): string {
  return text.slice(0, start) + text.slice(end);
}

/**
 * The range a Backspace at the empty selection's caret should swallow whole
 * (spec 018 US1 — one backspace removes the pill; no per-character nibbling
 * through hidden text). Inserted tokens carry a trailing space, so a caret
 * resting after that space (the common end-of-draft position) removes the
 * token together with its separator.
 */
export function tokenBackspaceAt(
  tokens: InlineToken[],
  text: string,
  caret: number,
): { start: number; end: number } | null {
  for (const t of tokens) {
    if (t.end === caret) return { start: t.start, end: t.end };
    if (t.end + 1 === caret && text[t.end] === " ") return { start: t.start, end: t.end + 1 };
  }
  return null;
}
