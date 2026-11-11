import { describe, expect, it } from "vitest";
import { sameActionIds } from "./messageActions";
import type { MessageAction } from "../store/types";

/**
 * 022 T409: the memo comparator for a message row. `actionsForItem` returns a
 * new array on every render, so comparing ids (not the reference) is what keeps
 * a stats update from repainting the whole transcript.
 */
describe("sameActionIds", () => {
  it("treats two empty lists as equal", () => {
    expect(sameActionIds([], [])).toBe(true);
  });

  it("compares by id sequence, not by array identity", () => {
    const a: MessageAction[] = ["copy", "quote", "fork"];
    const b: MessageAction[] = ["copy", "quote", "fork"];
    expect(a).not.toBe(b);
    expect(sameActionIds(a, b)).toBe(true);
  });

  it("detects a different id at the same length", () => {
    expect(sameActionIds(["copy", "quote"], ["copy", "fork"])).toBe(false);
  });

  it("detects a different length", () => {
    expect(sameActionIds(["copy"], ["copy", "fork"])).toBe(false);
    expect(sameActionIds([], ["copy"])).toBe(false);
  });

  it("short-circuits on the same reference", () => {
    const only: MessageAction[] = ["copy", "quote"];
    expect(sameActionIds(only, only)).toBe(true);
  });
});
