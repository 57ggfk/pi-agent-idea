/**
 * Scroll-and-flash navigation used by the session outline and search (spec 006).
 *
 * Positions are measured from live rects at call time (constitution III) —
 * never derived from scrollbar arithmetic or fixed assumptions about the
 * container geometry.
 */

export interface ScrollToItemOptions {
  /** Gap left above the target inside the viewport, in px. */
  offset?: number;
  /** How long the flash class stays on the target. */
  highlightMs?: number;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const FLASH_CLASS = "flash-target";

/**
 * Scrolls the message list so `[data-item-id]` sits `offset` px below the
 * viewport top, then flashes it. Returns false when the target does not exist.
 */
export function scrollToItem(
  listEl: HTMLElement,
  itemId: number | string,
  options: ScrollToItemOptions = {},
): boolean {
  const target = listEl.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(String(itemId))}"]`);
  if (!target) return false;

  const offset = options.offset ?? 12;
  const highlightMs = options.highlightMs ?? 2000;
  const listRect = listEl.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = Math.max(0, targetRect.top - listRect.top + listEl.scrollTop - offset);

  listEl.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });

  target.classList.add(FLASH_CLASS);
  window.setTimeout(() => target.classList.remove(FLASH_CLASS), highlightMs);
  return true;
}
