/**
 * User-message outline derivation (spec 006 US1): the "table of contents" is
 * the list of user messages in transcript order. Pure and unit-tested; the
 * component only formats and jumps.
 */
import type { ChatItem } from "../store/types";

export interface OutlineEntry {
  itemId: number;
  /** Single-line summary; UI truncates with CSS ellipsis. */
  text: string;
}

/** Placeholder for a user message without text (a pure image, FR: 场景 5). */
export const OUTLINE_IMAGE_PLACEHOLDER = "[image]";

export function outlineEntries(items: ChatItem[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  for (const item of items) {
    if (item.role !== "user") continue;
    if (item.ephemeral) continue; // steer traces are not real questions
    const text = item.blocks
      .filter((b): b is Extract<ChatItem["blocks"][number], { kind: "text" }> => b.kind === "text")
      .map((b) => b.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    entries.push({ itemId: item.id, text: text || OUTLINE_IMAGE_PLACEHOLDER });
  }
  return entries;
}
