import { describe, expect, test } from "vitest";
import { placeTooltip, type Rect } from "./tooltip";

/** T110 (012 US2): tooltip placement — flip to the side with room, then clamp
 *  inside the viewport. The tool window is small, so the flip matters more
 *  than the initial preference. */

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, width: w, height: h });
const viewport = { width: 800, height: 600 };
const tip = { width: 120, height: 24 };

describe("placeTooltip", () => {
  test("an anchor with room below places the tooltip under it", () => {
    const anchor = rect(100, 100, 40, 24);
    const p = placeTooltip(anchor, tip, viewport);
    expect(p.side).toBe("bottom");
    expect(p.top).toBe(100 + 24 + 6);
    expect(p.left).toBe(100 + 20 - 60); // centered on the anchor
  });

  test("an anchor near the bottom edge flips above", () => {
    const anchor = rect(100, 560, 40, 24);
    const p = placeTooltip(anchor, tip, viewport);
    expect(p.side).toBe("top");
    expect(p.top).toBe(560 - 6 - 24);
  });

  test("an anchor near the right edge clamps horizontally", () => {
    const anchor = rect(760, 100, 40, 24);
    const p = placeTooltip(anchor, tip, viewport);
    expect(p.left + tip.width).toBeLessThanOrEqual(viewport.width);
  });

  test("an anchor near the left edge clamps to the viewport edge", () => {
    const anchor = rect(2, 100, 40, 24);
    const p = placeTooltip(anchor, tip, viewport);
    expect(p.left).toBeGreaterThanOrEqual(0);
  });

  test("no room on either vertical side picks the roomier one and clamps", () => {
    // tall tip in a short viewport: both sides overflow, pick the roomier
    const anchor = rect(300, 300, 40, 24);
    const bigTip = { width: 120, height: 500 };
    const p = placeTooltip(anchor, bigTip, viewport);
    expect(["top", "bottom"]).toContain(p.side);
    expect(p.top).toBeGreaterThanOrEqual(0);
    expect(p.top + bigTip.height).toBeLessThanOrEqual(viewport.height);
  });

  test("the tooltip rectangle is always fully inside the viewport", () => {
    const spots = [
      rect(0, 0, 60, 20),
      rect(780, 580, 20, 20),
      rect(390, 295, 20, 10),
      rect(-10, -10, 100, 40),
    ];
    for (const anchor of spots) {
      const p = placeTooltip(anchor, tip, viewport);
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.top).toBeGreaterThanOrEqual(0);
      expect(p.left + tip.width).toBeLessThanOrEqual(viewport.width);
      expect(p.top + tip.height).toBeLessThanOrEqual(viewport.height);
    }
  });
});
