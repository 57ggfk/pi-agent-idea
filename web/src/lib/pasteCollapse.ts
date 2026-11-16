/**
 * 044: paste-folding decision + token bookkeeping (pure logic, no DOM).
 *
 * The textarea carries a stable, language-neutral token
 * `[Pasted {Kind} #N +X lines]`; the real content lives in the composer's
 * paste map and is restored by [expandPastes] right before sending (FR-007) —
 * so pi always receives the full original text, and the sent transcript
 * remains fully viewable/copyable.
 */

export type PasteKind = "Markdown" | "JSON" | "code" | "log" | "text";

/** >3 lines or >800 chars — either one folds (FR-001, 044 Q1). */
export const PASTE_LINE_THRESHOLD = 3;
export const PASTE_CHAR_THRESHOLD = 800;
/** Larger pastes are offered (not forced) the save-as-file route (FR-011). */
export const PASTE_FILE_LINES_THRESHOLD = 2000;

/** Lines = newline count + 1 (CRLF already collapsed by the caller). */
export function countLines(text: string): number {
  return text.split("\n").length;
}

export function shouldCollapse(text: string): boolean {
  return countLines(text) > PASTE_LINE_THRESHOLD || text.length > PASTE_CHAR_THRESHOLD;
}

/**
 * Lightweight content sniffing (FR-003, no language-detection dependency):
 * JSON first (parseable = unambiguous), then log shapes, then Markdown
 * features, then common code tokens, else plain text.
 */
export function detectPasteKind(raw: string): PasteKind {
  const text = raw.replace(/\r\n/g, "\n");
  const trimmed = text.trim();
  if (!trimmed) return "text";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "JSON";
    } catch {
      // fall through — a brace-heavy prose text stays prose
    }
  }
  const lines = trimmed.split("\n");
  const logish = lines.filter((l) =>
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(l) ||
    /\[(?:ERROR|WARN|INFO|DEBUG|TRACE)\]/.test(l) ||
    / (?:ERROR|WARN|FATAL): /.test(l),
  ).length;
  if (logish >= 1 && logish * 2 >= lines.length) return "log";
  const mdish = lines.filter((l) =>
    /^#{1,6} /.test(l) ||
    /^\s*[-*+] /.test(l) ||
    /^\s*\d+\. /.test(l) ||
    /^```/.test(l) ||
    /^\|.+\|$/.test(l) ||
    /\*\*[^*]+\*\*/.test(l),
  ).length;
  if (mdish >= 1 && mdish * 2 >= lines.length) return "Markdown";
  const codeTokens = [
    /\bfunction\b/, /\bdef\b/, /\bclass\b/, /\bimport\b/, /\bexport\b/, /\bconst\b/, /\blet\b/, /\breturn\b/,
    /=>/, /;\s*$/, /[{};]/,
  ];
  const codish = lines.filter((l) => codeTokens.some((re) => re.test(l))).length;
  if (codish >= 2 && codish * 2 >= lines.length) return "code";
  return "text";
}

/** The exact token text that sits in the textarea (FR-003 line count, neutral wording). */
export function pasteToken(id: number, kind: PasteKind, lines: number): string {
  return `[Pasted ${kind} #${id} +${lines} lines]`;
}

/** Finds paste tokens; the id is the restore key, so the surrounding wording may evolve. */
const PASTE_TOKEN_RE = /\[Pasted (?:[A-Za-z]+) #(\d+) \+(\d+) lines\]/g;

/** True when the draft still carries paste tokens. */
export function hasPasteTokens(text: string): boolean {
  PASTE_TOKEN_RE.lastIndex = 0;
  return PASTE_TOKEN_RE.test(text);
}

/**
 * Restores every paste token to its full original content (FR-007). Unknown
 * ids (entry deleted from the map but token text still present) expand to
 * the empty string? No — they stay as-is: a token whose content we no longer
 * hold must not silently shrink to nothing; sending the visible token text
 * keeps the user's draft honest.
 */
export function expandPastes(text: string, contents: Map<number, string>): string {
  return text.replace(PASTE_TOKEN_RE, (match, idStr: string) => {
    const id = Number(idStr);
    const content = contents.get(id);
    return content === undefined ? match : content;
  });
}

/** Replaces exactly one token occurrence (by id) with the given replacement. */
export function replaceToken(text: string, id: number, replacement: string): { text: string; start: number; end: number } | null {
  PASTE_TOKEN_RE.lastIndex = 0;
  for (let m = PASTE_TOKEN_RE.exec(text); m !== null; m = PASTE_TOKEN_RE.exec(text)) {
    if (Number(m[1]) === id) {
      const start = m.index;
      const end = start + m[0].length;
      return { text: text.slice(0, start) + replacement + text.slice(end), start, end };
    }
  }
  return null;
}
