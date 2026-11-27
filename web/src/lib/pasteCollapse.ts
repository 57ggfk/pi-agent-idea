/**
 * 044: paste-folding decision + token bookkeeping (pure logic, no DOM).
 *
 * The textarea carries a token whose MACHINE CORE — `#<id> +<lines>` — is
 * byte-identical in every language; the words around it ("Pasted"/"已粘贴",
 * "lines"/"行", the kind name) are localized and handed in by the caller. The
 * real content lives in the composer's paste map and is restored by
 * [expandPastes] right before sending (FR-007) — so pi always receives the
 * full original text, and the sent transcript remains fully viewable/copyable.
 *
 * The token grammar lives here and ONLY here: the composer scans with
 * [scanPasteTokens] instead of keeping a second copy of the pattern, so the
 * next wording change cannot drift between the two (issue #11).
 *
 * The scanner matches the words around the core loosely on purpose — a token
 * created in the English UI must still be recognized (and expandable) after
 * the user switches to Chinese, and the other way round. The core itself
 * (`#<id> +<lines>`) is the only part the restore key depends on.
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

/**
 * 044 #4 (feedback batch): pastes beyond the file threshold auto-save to a
 * temp file reference (no prompt) — the chip is the fallback when the write
 * fails. Boundary-inclusive: exactly 2000 lines stays a chip.
 */
export function shouldAutoSaveAsFile(lines: number): boolean {
  return lines > PASTE_FILE_LINES_THRESHOLD;
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

/**
 * The wording around the machine core — the caller localizes it (issue #11).
 *
 * The core (`#<id> +<lines>`) is the same in every language; only these
 * words change. They are passed in because this module is a pure function
 * library: it must not know about i18n.
 */
export interface PasteTokenWords {
  /** The word that introduces the chip: "Pasted" / "已粘贴". */
  pasted: string;
  /** The unit word: "lines" / "行". */
  lines: string;
  /** The localized kind name per kind ("code" / "代码"). */
  kinds: Record<PasteKind, string>;
}

/** The exact token text that sits in the textarea (FR-003 line count). */
export function pasteToken(id: number, kind: PasteKind, lines: number, words: PasteTokenWords): string {
  return `[${words.pasted} ${words.kinds[kind] ?? kind} #${id} +${lines} ${words.lines}]`;
}

/**
 * Finds paste tokens; the id is the restore key, so the surrounding wording
 * may evolve — and it DOES differ per language, which is why the words are
 * matched loosely: only the machine core (`#<id> +<lines>`) is fixed.
 *
 * Groups: 1 = the words before the core, 2 = the id, 3 = the line count,
 * 4 = the unit word after the core.
 */
export const PASTE_TOKEN_RE = /\[([^\[\]\n#+]+) #(\d+) \+(\d+) ([^\[\]\n#+]*)\]/g;

/** One paste token found in a draft. */
export interface PasteTokenMatch {
  /** The token text as it sits in the draft (byte-identical to it). */
  text: string;
  /** The restore key. */
  id: number;
  /** The line count the token carries. */
  lines: number;
  /** Where the token starts in the draft. */
  start: number;
  /** Where the token ends in the draft. */
  end: number;
}

/**
 * The ONE scanner for paste tokens (issue #11): the composer renders its
 * chips from this, so the draft text and the chip layer can never disagree
 * about where a token is.
 */
export function scanPasteTokens(text: string): PasteTokenMatch[] {
  const out: PasteTokenMatch[] = [];
  PASTE_TOKEN_RE.lastIndex = 0;
  for (let m = PASTE_TOKEN_RE.exec(text); m !== null; m = PASTE_TOKEN_RE.exec(text)) {
    out.push({
      text: m[0],
      id: Number(m[2]),
      lines: Number(m[3]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

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
  // Group 2 is the id (group 1 is the localized wording before the core).
  return text.replace(PASTE_TOKEN_RE, (match, _prefix: string, idStr: string) => {
    const id = Number(idStr);
    const content = contents.get(id);
    return content === undefined ? match : content;
  });
}

/** Replaces exactly one token occurrence (by id) with the given replacement. */
export function replaceToken(text: string, id: number, replacement: string): { text: string; start: number; end: number } | null {
  PASTE_TOKEN_RE.lastIndex = 0;
  for (let m = PASTE_TOKEN_RE.exec(text); m !== null; m = PASTE_TOKEN_RE.exec(text)) {
    if (Number(m[2]) === id) {
      const start = m.index;
      const end = start + m[0].length;
      return { text: text.slice(0, start) + replacement + text.slice(end), start, end };
    }
  }
  return null;
}
