import { describe, expect, it } from "vitest";
import { NOTCH_MIN_PX, WHEEL_GAIN, wheelPixels } from "./wheel";

/**
 * `findScroller` / `installWheelGain` need a real layout (scrollHeight,
 * clientHeight, clamping), so they are covered in `e2e/wheel-gain.spec.ts`.
 * The conversion is the part worth pinning here: getting the mode wrong turns
 * a 3-line notch into 3 pixels.
 */
describe("wheelPixels", () => {
  it("passes pixel deltas through untouched", () => {
    expect(wheelPixels(120, 0, 756)).toBe(120);
    expect(wheelPixels(-53, 0, 756)).toBe(-53);
  });

  it("turns line deltas into pixels", () => {
    expect(wheelPixels(3, 1, 756)).toBe(48);
    expect(wheelPixels(-3, 1, 756)).toBe(-48);
  });

  it("turns page deltas into the viewport height", () => {
    expect(wheelPixels(1, 2, 756)).toBe(756);
    expect(wheelPixels(-2, 2, 400)).toBe(-800);
  });
});

describe("measured defaults", () => {
  // The real machine sends one detent as deltaY=100 and Chromium already moves
  // 100px, so the takeover must NOT lengthen the step: the defect was the
  // 190ms animation, not the distance. If this ever changes, the probe run in
  // `web/probe-wheel-scale.mjs` is the thing to re-read first.
  it("keeps the browser's 100px notch instead of inventing a new distance", () => {
    expect(WHEEL_GAIN).toBe(1);
    expect(wheelPixels(100, 0, 756) * WHEEL_GAIN).toBe(100);
  });

  it("counts a detent as ≥40px and a trackpad dribble as less", () => {
    expect(NOTCH_MIN_PX).toBe(40);
    expect(wheelPixels(100, 0, 756)).toBeGreaterThanOrEqual(NOTCH_MIN_PX);
    expect(wheelPixels(12, 0, 756)).toBeLessThan(NOTCH_MIN_PX);
    // A 3-line delta is a detent too (mode 1 normalises to 48px).
    expect(wheelPixels(3, 1, 756)).toBeGreaterThanOrEqual(NOTCH_MIN_PX);
  });
});
