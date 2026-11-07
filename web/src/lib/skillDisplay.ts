/**
 * Skill-reference display (011 US4, T014).
 *
 * When a prompt starts with `/skill:<name>`, pi replaces the user message with
 * a single `type:"text"` block carrying the full SKILL.md body:
 *
 * ```
 * <skill name="…" location="…/SKILL.md">
 * References are relative to <skill dir>.
 *
 * <body, frontmatter stripped, trimmed>
 * </skill>
 *
 * <user args, if any>
 * ```
 *
 * The raw command is not preserved anywhere (session jsonl already holds the
 * expanded text), so folding must happen at display time from the expanded
 * form alone. The recognition regex is pi's own `parseSkillBlock` rule — same
 * boundaries, so handwritten look-alikes (wrong line breaks, missing
 * location, trailing text after `</skill>`) never fold (FR-015).
 */

export interface ParsedSkillBlock {
  name: string;
  location: string;
  /** SKILL.md body with the frontmatter stripped and trimmed. */
  content: string;
  /** The user's original question, trimmed; "" for a bare reference. */
  userMessage: string;
}

const SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** pi's official inverse mapping for an expanded `/skill:` message. */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
  const match = SKILL_BLOCK_RE.exec(text);
  if (!match) return null;
  return {
    name: match[1],
    location: match[2],
    content: match[3],
    userMessage: (match[4] ?? "").trim(),
  };
}

/** True when the text is exactly an expanded skill message. */
export function isSkillExpanded(text: string): boolean {
  return SKILL_BLOCK_RE.test(text);
}

/**
 * The text a user message shows: the `/skill:<name>` reference marker plus the
 * original question, never the SKILL.md body. Data layers (store, search,
 * export, copy sources) keep pi's raw text; only presentation goes through
 * here (T015/T016 single conversion point).
 */
export function displaySkillText(text: string): string {
  const parsed = parseSkillBlock(text);
  if (!parsed) return text;
  return parsed.userMessage ? `/skill:${parsed.name} ${parsed.userMessage}` : `/skill:${parsed.name}`;
}
