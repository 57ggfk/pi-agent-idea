/**
 * Tooltip placement (012 US2, T110) — pure geometry, unit-testable without a
 * DOM. The tool window is small and the anchor can sit anywhere, so the rule
 * is: flip to whichever vertical side has room, then clamp both axes inside
 * the viewport. No third-party floating library (plan D5).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TooltipPlacement {
  top: number;
  left: number;
  side: "top" | "bottom";
}

const GAP = 6;
const EDGE = 4;

export function placeTooltip(
  anchor: Rect,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
): TooltipPlacement {
  const spaceBelow = viewport.height - (anchor.y + anchor.height);
  const spaceAbove = anchor.y;
  // Prefer below; flip only when below cannot fit AND above fits better.
  const side: "top" | "bottom" =
    spaceBelow >= tip.height + GAP || spaceBelow >= spaceAbove ? "bottom" : "top";

  let top = side === "bottom" ? anchor.y + anchor.height + GAP : anchor.y - tip.height - GAP;
  // Center on the anchor, then clamp into the viewport.
  let left = anchor.x + anchor.width / 2 - tip.width / 2;
  top = Math.min(Math.max(top, EDGE), Math.max(EDGE, viewport.height - tip.height - EDGE));
  left = Math.min(Math.max(left, EDGE), Math.max(EDGE, viewport.width - tip.width - EDGE));
  return { top, left, side };
}
