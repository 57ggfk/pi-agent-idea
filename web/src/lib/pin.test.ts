import { describe, expect, it } from "vitest";
import { BOTTOM_EPS, initialPin, nextPin, pinnedScrollTop, shouldStick } from "./pin";

/**
 * 022 T406: the "滑到底再往上滑不动" bug. Each case is a real gesture against
 * a 1000px transcript in a 400px viewport (a wheel notch up is negative).
 */
const VIEW = 400;
const HEIGHT = 1000;
const BOTTOM = HEIGHT - VIEW;

const pinnedAtBottom = () => ({ ...initialPin(), lastTop: BOTTOM, lastHeight: HEIGHT });

describe("nextPin", () => {
  it("unpins on an upward wheel gesture even a few px from the bottom", () => {
    const next = nextPin(pinnedAtBottom(), BOTTOM - 20, HEIGHT, VIEW, true);
    expect(next.pinned).toBe(false);
    expect(next.lastTop).toBe(BOTTOM - 20);
  });

  it("unpins before the old 60px threshold was ever crossed", () => {
    // 50px from the bottom: the old rule still said "stick", the new one does not.
    const nearBottom = BOTTOM - 50;
    const state = { pinned: true, lastTop: nearBottom + 10, lastHeight: HEIGHT };
    expect(nextPin(state, nearBottom, HEIGHT, VIEW, true).pinned).toBe(false);
  });

  it("repins only at the very bottom (within the epsilon)", () => {
    expect(nextPin({ pinned: false, lastTop: 100, lastHeight: HEIGHT }, BOTTOM, HEIGHT, VIEW).pinned).toBe(true);
    expect(
      nextPin({ pinned: false, lastTop: 100, lastHeight: HEIGHT }, BOTTOM - BOTTOM_EPS, HEIGHT, VIEW).pinned,
    ).toBe(true);
    expect(
      nextPin({ pinned: false, lastTop: 100, lastHeight: HEIGHT }, BOTTOM - BOTTOM_EPS - 1, HEIGHT, VIEW).pinned,
    ).toBe(false);
  });

  it("keeps a pinned view pinned when content grows but the user does not scroll", () => {
    const grew = nextPin(pinnedAtBottom(), BOTTOM, HEIGHT + 300, VIEW);
    expect(grew.pinned).toBe(true);
    expect(grew.lastHeight).toBe(HEIGHT + 300);
  });

  it("keeps an unpinned view unpinned while scrolling down inside the transcript", () => {
    const next = nextPin({ pinned: false, lastTop: 100, lastHeight: HEIGHT }, 200, HEIGHT, VIEW);
    expect(next.pinned).toBe(false);
  });

  it("infers an upward move when the content size did not change", () => {
    const next = nextPin({ pinned: true, lastTop: 500, lastHeight: HEIGHT }, 400, HEIGHT, VIEW);
    expect(next.pinned).toBe(false);
  });

  it("does not mistake a shorter offset for a gesture when the height changed", () => {
    // content-visibility re-measuring shrinks scrollHeight and clamps scrollTop
    const next = nextPin({ pinned: true, lastTop: 500, lastHeight: HEIGHT }, 300, HEIGHT - 200, VIEW);
    expect(next.pinned).toBe(true);
  });

  it("records every position so the next inference is correct", () => {
    const a = nextPin(initialPin(), 120, HEIGHT, VIEW);
    expect(a.lastTop).toBe(120);
    const b = nextPin(a, 60, HEIGHT, VIEW);
    expect(b).toEqual({ pinned: false, lastTop: 60, lastHeight: HEIGHT });
  });

  it("exposes the follow-up intent in one place", () => {
    expect(shouldStick({ pinned: true, lastTop: 0, lastHeight: 0 })).toBe(true);
    expect(shouldStick({ pinned: false, lastTop: 0, lastHeight: 0 })).toBe(false);
    expect(pinnedScrollTop(1234)).toBe(1234);
  });
});
