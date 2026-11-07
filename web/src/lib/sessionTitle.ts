import { parseSkillBlock } from "./skillDisplay";

/**
 * Session title derivation (012 US1, T109).
 *
 * T101 evidence: pi 1.4.0 never names sessions on its own — the only writers
 * are `-n`, the TUI `/name` and the `set_session_name` RPC. The plugin takes
 * over with the agreed fallback: the first user message becomes the title,
 * which is then written back through `set_session_name` so pi persists it and
 * broadcasts `session_info_changed`. No extra model call is ever made.
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
 * (011 US4 — the marker + question, never the SKILL.md body), every run of
 * whitespace collapses to one space, and the result is capped at
 * [SESSION_TITLE_MAX] code points with an ellipsis. Returns null when there
 * is nothing title-worthy (empty message, pure-image prompt).
 */
export function deriveSessionTitle(raw: string): string | null {
  if (!raw.trim()) return null;
  const skill = parseSkillBlock(raw);
  const base = skill ? (skill.userMessage || `/skill:${skill.name}`) : raw;
  const flat = base.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const chars = [...flat];
  if (chars.length <= SESSION_TITLE_MAX) return flat;
  return chars.slice(0, SESSION_TITLE_MAX).join("") + "…";
}
