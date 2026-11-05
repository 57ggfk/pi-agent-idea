import { describe, expect, test } from "vitest";
import { clampComposerHeight, composerMaxHeight, MIN_COMPOSER_HEIGHT } from "./autosize";

/** T002: the height policy has exactly one implementation. Cases from
 *  specs/010-ui-polish tasks.md T002 — appHeight 300/600/1200 → cap
 *  135/270/320; a scrollHeight below the single-line floor returns the floor. */
describe("composerMaxHeight", () => {
  test("0.45 × app height when that is under the absolute cap", () => {
    expect(composerMaxHeight(300)).toBe(135);
    expect(composerMaxHeight(600)).toBe(270);
  });

  test("absolute cap applies once 45% of the app exceeds it", () => {
    expect(composerMaxHeight(1200)).toBe(320);
    expect(composerMaxHeight(760)).toBe(320);
  });

  test("tiny app heights never produce a degenerate cap", () => {
    expect(composerMaxHeight(0)).toBe(0);
    expect(composerMaxHeight(-10)).toBe(0);
    expect(composerMaxHeight(100)).toBe(45);
  });
});

describe("clampComposerHeight", () => {
  const app = 760; // cap = 320

  test("content below the single-line floor grows to the floor", () => {
    expect(clampComposerHeight(10, app)).toBe(MIN_COMPOSER_HEIGHT);
    expect(clampComposerHeight(0, app)).toBe(MIN_COMPOSER_HEIGHT);
    expect(clampComposerHeight(NaN, app)).toBe(MIN_COMPOSER_HEIGHT);
  });

  test("content between floor and cap is used verbatim", () => {
    expect(clampComposerHeight(120, app)).toBe(120);
    expect(clampComposerHeight(320, app)).toBe(320);
  });

  test("content above the cap is capped (the textarea scrolls inside)", () => {
    expect(clampComposerHeight(400, app)).toBe(320);
  });

  test("the cap tracks the app height, not the absolute cap alone", () => {
    // app 300 → cap 135
    expect(clampComposerHeight(400, 300)).toBe(135);
    // app 600 → cap 270
    expect(clampComposerHeight(400, 600)).toBe(270);
  });
});
