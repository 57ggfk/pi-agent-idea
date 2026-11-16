import { describe, expect, it } from "vitest";
import { findTempRefPaths } from "./tempRefs";

/** 044 FR-014: only pi-paste temp references are existence-checked. */
describe("findTempRefPaths", () => {
  it("finds temp paste references among other tokens", () => {
    const text = "see @C:\\temp\\pi-paste-1-x\\pasted-1.txt and @src/App.tsx";
    expect(findTempRefPaths(text)).toEqual(["C:\\temp\\pi-paste-1-x\\pasted-1.txt"]);
  });

  it("returns duplicates only once", () => {
    const text = "@C:\\t\\pi-paste-a\\f.txt and again @C:\\t\\pi-paste-a\\f.txt";
    expect(findTempRefPaths(text)).toEqual(["C:\\t\\pi-paste-a\\f.txt"]);
  });

  it("ignores drafts without temp references", () => {
    expect(findTempRefPaths("plain words @src/main.tsx only")).toEqual([]);
    expect(findTempRefPaths("")).toEqual([]);
  });
});
