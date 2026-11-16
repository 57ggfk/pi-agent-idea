import { findTokens } from "./inlineChips";

/**
 * 044 FR-014: temp paste files (files.saveTemp) live under the system temp
 * dir in a `pi-paste-…` directory and are cleaned at session end. A draft or
 * a message can still carry an `@path` reference to a file that no longer
 * exists — those references must never be submitted silently.
 */
export const TEMP_REF_MARKER = "pi-paste-";

/** All `@…` tokens in the draft whose path points into a temp paste dir. */
export function findTempRefPaths(text: string): string[] {
  const seen = new Set<string>();
  for (const tok of findTokens(text)) {
    if (tok.path.includes(TEMP_REF_MARKER)) seen.add(tok.path);
  }
  return [...seen];
}
