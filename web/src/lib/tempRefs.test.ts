import { describe, expect, it } from "vitest";
import { findTempRefPaths } from "./tempRefs";

/** 044 FR-014: only pi-paste temp references are existence-checked. */
describe("findTempRefPaths", () => {
  it("finds temp paste references among other tokens", () => {
    const text = "see @C:\\Users\\t\\.pi-agent\\pi-paste\\a3f9c2-1.txt and @src/App.tsx";
    expect(findTempRefPaths(text)).toEqual(["C:\\Users\\t\\.pi-agent\\pi-paste\\a3f9c2-1.txt"]);
  });

  it("returns duplicates only once", () => {
    const text = "@C:\\t\\pi-paste\\a3f9c2-1.txt and again @C:\\t\\pi-paste\\a3f9c2-1.txt";
    expect(findTempRefPaths(text)).toEqual(["C:\\t\\pi-paste\\a3f9c2-1.txt"]);
  });

  it("ignores drafts without temp references", () => {
    expect(findTempRefPaths("plain words @src/main.tsx only")).toEqual([]);
    expect(findTempRefPaths("")).toEqual([]);
  });
});
