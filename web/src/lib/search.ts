/**
 * Session search hit computation (spec 006 US2).
 *
 * Counting and navigation run on the transcript model (pure, unit-tested);
 * painting happens in the DOM (SessionSearch). Matching is literal — the
 * query is never interpreted as a regular expression (FR-014) — and
 * case-insensitive for latin text.
 */
import type { ChatItem } from "../store/types";

export interface SearchHit {
  itemId: number;
  /** Index of the block inside the item that contains the match. */
  blockIndex: number;
  /** "text" = message text block, "tool-output" = a tool result output. */
  kind: "text" | "tool-output";
  /** Char offset of the match inside the block text. */
  offset: number;
  length: number;
  /** Short context window around the match for result lists. */
  preview: string;
}

const PREVIEW_CONTEXT = 48;

/** The searchable text of one block, or null when the block is skipped. */
function searchableText(block: ChatItem["blocks"][number]): { text: string; kind: SearchHit["kind"] } | null {
  if (block.kind === "text") {
    // Empty text blocks stream in before their deltas arrive.
    return block.text ? { text: block.text, kind: "text" } : null;
  }
  if (block.kind === "toolcall") {
    // Thinking blocks and image data are never searched (FR-006); command
    // output is — users locate things by what a command printed.
    const output = block.result?.output ?? "";
    return output ? { text: output, kind: "tool-output" } : null;
  }
  return null;
}

/** All hits of `query` across the transcript, in transcript order. */
export function hitsFromItems(items: ChatItem[], query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (const item of items) {
    item.blocks.forEach((block, blockIndex) => {
      const searchable = searchableText(block);
      if (!searchable) return;
      const haystack = searchable.text.toLowerCase();
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;
        hits.push({
          itemId: item.id,
          blockIndex,
          kind: searchable.kind,
          offset: at,
          length: needle.length,
          preview: previewOf(searchable.text, at, needle.length),
        });
        from = at + needle.length;
      }
    });
  }
  return hits;
}

function previewOf(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - PREVIEW_CONTEXT);
  const end = Math.min(text.length, offset + length + PREVIEW_CONTEXT);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
}
