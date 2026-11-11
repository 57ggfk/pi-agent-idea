import type { MessageAction } from "../store/types";

/**
 * 022 D5: `actionsForItem()` builds a fresh array on every render, so a plain
 * shallow compare in `React.memo` would always say "changed". Comparing the
 * action *ids* is enough — the set of buttons is the only thing the toolbar
 * renders, and it is at most five entries.
 */
export function sameActionIds(a: MessageAction[], b: MessageAction[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
