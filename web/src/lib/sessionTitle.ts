import { parseSkillBlock } from "./skillDisplay";

/**
 * Session title derivation (012 US1, T109) plus the B-stage LLM refinement.
 *
 * T101 evidence: pi 1.4.0 never names sessions on its own — the only writers
 * are `-n`, the TUI `/name` and the `set_session_name` RPC. The plugin takes
 * over in two stages: A derives the title from the first user message (no
 * model call — the durable fallback), then B, after the first assistant
 * reply, asks a one-shot `pi -p` process for a proper title. B's result
 * overwrites A's through the same `set_session_name` write-back; B failing,
 * timing out or being killed leaves A's title untouched.
 */

export const SESSION_TITLE_MAX = 32;

/** "ok", or why the name cannot be committed as typed. */
export function validateSessionTitle(name: string): "ok" | "empty" | "long" {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if ([...trimmed].length > SESSION_TITLE_MAX) return "long";
  return "ok";
}

/**
 * The title for a first user message: skill-expanded messages fold first
 * (011 US4 — the marker + question, never the SKILL.md body), IDE scaffold
 * prompts (add directory / explain / fix / send selection) collapse to the
 * action's subject instead of the boilerplate sentence, every run of
 * whitespace collapses to one space, and the result is capped at
 * [SESSION_TITLE_MAX] code points with an ellipsis. Returns null when there
 * is nothing title-worthy (empty message, pure-image prompt).
 */
export function deriveSessionTitle(raw: string): string | null {
  if (!raw.trim()) return null;
  const skill = parseSkillBlock(raw);
  if (skill) return capTitle(flatten(skill.userMessage || `/skill:${skill.name}`));
  return capTitle(scaffoldTitle(raw) ?? flatten(raw));
}

const flatten = (s: string): string => s.replace(/\s+/g, " ").trim();

const capTitle = (flat: string): string | null => {
  if (!flat) return null;
  const chars = [...flat];
  if (chars.length <= SESSION_TITLE_MAX) return flat;
  return chars.slice(0, SESSION_TITLE_MAX).join("") + "…";
};

/**
 * Scaffold prompts pushed by the IDE actions (PiEditorActions.kt /
 * DirectoryListing.kt — the composer prefills them verbatim). Their first
 * sentence is plumbing, so title from the subject: "Here is the directory
 * `src` (…)" → "Directory: src". A real question typed after the directory
 * trailer beats the subject. Unknown text falls through (null).
 */
const DIRECTORY_HEAD = /^Here is the directory `([^`]+)` \(/;
const LOOK_AT_HEAD = /^Look at (?:the directory )?`([^`]+)`/; // "Explain File with Pi"
const CODE_FROM_HEAD = /^(Explain|Fix) the following code from `([^`]+)`/; // selection actions
const REGARDING_HEAD = /^Regarding `([^`]+)`:/; // "Send Selection to Pi"
const DIRECTORY_TRAILER = "\nRead whatever you need.";

function scaffoldTitle(raw: string): string | null {
  const dir = DIRECTORY_HEAD.exec(raw);
  if (dir) {
    const idx = raw.indexOf(DIRECTORY_TRAILER);
    const tail = idx >= 0 ? raw.slice(idx + DIRECTORY_TRAILER.length).trim() : "";
    if (tail) return flatten(tail);
    return `Directory: ${dir[1]}`;
  }
  const code = CODE_FROM_HEAD.exec(raw);
  if (code) return `${code[1]}: ${code[2]}`;
  const regarding = REGARDING_HEAD.exec(raw);
  if (regarding) return `Selection: ${regarding[1]}`;
  const look = LOOK_AT_HEAD.exec(raw);
  if (look) return `Explain: ${look[1]}`;
  return null;
}

// -- B stage: the LLM-generated refinement -----------------------------------

/** Code-point clip for the excerpt sent to the title call (CJK-safe). */
export const clipTitleInput = (s: string, max: number): string => {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max).join("");
};

/**
 * Cleans a model-generated title: the first non-blank line only, one pair of
 * wrapping quotes stripped (models add them despite instructions), whitespace
 * collapsed, capped like any other title. Empty output → null → A's title
 * stays.
 */
export function sanitizeLlmTitle(raw: string): string | null {
  const line = raw.split("\n").find((l) => l.trim()) ?? "";
  let t = line.trim();
  if (t.length >= 2) {
    const quotes = "\"'`“”‘’「『";
    if (quotes.includes(t[0]) && quotes.includes(t[t.length - 1])) {
      t = t.slice(1, -1).trim();
    }
  }
  return capTitle(flatten(t));
}
