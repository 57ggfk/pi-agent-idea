/**
 * Search-hit painting (spec 006 US2 / FR-008).
 *
 * Counting and navigation run on the transcript model (`hitsFromItems`); this
 * module paints those hits in the DOM without touching the markdown structure:
 * it only creates `Range`s over existing text nodes — CSS Custom Highlight API
 * where available, an absolutely-positioned overlay where not (JCEF fallback).
 *
 * Model offsets live in the markdown SOURCE, while the DOM shows rendered
 * text. Ranges are therefore placed by occurrence ordinal: the k-th model hit
 * inside a block paints over the k-th occurrence of the query in that block's
 * DOM text. Identical for plain text and tool output; a divergence can only
 * skip a highlight, never misplace one.
 */
import type { SearchHit } from "./search";

const HITS_KEY = "search-hits";
const CURRENT_KEY = "search-current";
const OVERLAY_CLASS = "search-hits-layer";

interface HighlightRegistryLike {
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

declare const Highlight: { new (...ranges: Range[]): unknown } | undefined;

function cssHighlights(): HighlightRegistryLike | null {
  if (typeof CSS === "undefined") return null;
  return (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights ?? null;
}

export const customHighlightsAvailable = (): boolean => {
  if (!cssHighlights()) return false;
  return typeof Highlight === "function";
};

/** Removes every painted hit (registry entries + overlay layer). */
export function clearSearchHighlights(): void {
  const highlights = cssHighlights();
  if (highlights) {
    highlights.delete(HITS_KEY);
    highlights.delete(CURRENT_KEY);
  }
  document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
}

/**
 * Paints `hits` for `query` inside `container` (the message list); the hit at
 * `currentIndex` additionally gets the current-hit highlight. Safe to call on
 * every commit: it first clears whatever the previous pass painted.
 */
export function paintSearchHighlights(
  container: HTMLElement,
  query: string,
  hits: SearchHit[],
  currentIndex: number,
): void {
  clearSearchHighlights();
  const needle = query.trim().toLowerCase();
  if (hits.length === 0 || !needle) return;

  const ordinals = new Map<string, number>();
  const painted: Array<{ range: Range; index: number }> = [];
  hits.forEach((hit, index) => {
    const key = `${hit.itemId}:${hit.blockIndex}`;
    const occurrence = ordinals.get(key) ?? 0;
    ordinals.set(key, occurrence + 1);
    const range = rangeForHit(container, hit, needle, occurrence);
    if (range) painted.push({ range, index });
  });

  if (customHighlightsAvailable()) {
    const highlights = cssHighlights()!;
    const HighlightCtor = Highlight as new (...ranges: Range[]) => unknown;
    highlights.set(HITS_KEY, new HighlightCtor(...painted.map((p) => p.range)));
    const current = painted.find((p) => p.index === currentIndex);
    if (current) highlights.set(CURRENT_KEY, new HighlightCtor(current.range));
    return;
  }

  paintOverlay(painted.map((p) => p.range), currentIndex);
}

// -- range construction ------------------------------------------------------

function blockElementFor(container: HTMLElement, hit: SearchHit): Element | null {
  const itemEl = container.querySelector(`[data-item-id="${CSS.escape(String(hit.itemId))}"]`);
  if (!itemEl) return null;
  if (itemEl.classList.contains("system-item")) return itemEl.children[hit.blockIndex] ?? null;
  const body = itemEl.querySelector(".item-body");
  if (!body) return null;
  const blockEl = body.children[hit.blockIndex] ?? null;
  if (!blockEl) return null;
  if (hit.kind === "tool-output") {
    // The card head (tool name, args) is not part of the searched text; only
    // the expanded output pane carries it.
    return blockEl.querySelector(".tool-output");
  }
  return blockEl;
}

/** Builds a range over the `occurrence`-th match inside the block's DOM text. */
function rangeForHit(
  container: HTMLElement,
  hit: SearchHit,
  needle: string,
  occurrence: number,
): Range | null {
  const blockEl = blockElementFor(container, hit);
  if (!blockEl) return null;
  const domText = blockEl.textContent ?? "";
  const at = nthIndexOf(domText, needle, occurrence);
  if (at < 0) return null;
  return rangeAtOffset(blockEl, at, needle.length);
}

/** Maps a block-text offset onto text nodes and returns the covering range. */
function rangeAtOffset(blockEl: Element, start: number, length: number): Range | null {
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const len = text.length;
    if (!startNode && pos + len > start) {
      startNode = text;
      startOffset = start - pos;
    }
    if (startNode) {
      const end = start + length; // absolute end within the block text
      if (pos + len >= end) {
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(text, end - pos);
        return range;
      }
    }
    pos += len;
  }
  return null;
}

function nthIndexOf(haystack: string, needle: string, occurrence: number): number {
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return -1;
    if (i === occurrence) return at;
    from = at + needle.length;
  }
  return -1;
}

// -- overlay fallback (no CSS Custom Highlight API) ---------------------------

function paintOverlay(ranges: Range[], currentIndex: number): void {
  const layer = document.createElement("div");
  layer.className = OVERLAY_CLASS;
  layer.setAttribute("data-testid", "search-hits-overlay");
  ranges.forEach((range, i) => {
    for (const rect of range.getClientRects()) {
      const box = document.createElement("div");
      box.className = i === currentIndex ? "search-hit-rect search-hit-current" : "search-hit-rect";
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      layer.appendChild(box);
    }
  });
  document.body.appendChild(layer);
}
