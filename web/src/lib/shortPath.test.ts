import { describe, expect, it } from "vitest";
import { shortPath } from "./shortPath";

/** 036 FR-006/FR-007: one shared implementation, case- and slash-insensitive. */
describe("shortPath", () => {
  const home = "C:\\Users\\Administrator";

  it("shortens home-prefixed paths with backslashes", () => {
    expect(shortPath("C:\\Users\\Administrator\\.pi\\agent", home)).toBe("~/.pi/agent");
  });

  it("shortens forward-slash paths too", () => {
    expect(shortPath("C:/Users/Administrator/notes/a.md", home)).toBe("~/notes/a.md");
  });

  it("matches case-insensitively", () => {
    expect(shortPath("c:\\users\\administrator\\x.json", home)).toBe("~/x.json");
  });

  it("leaves paths outside home untouched", () => {
    expect(shortPath("D:\\code\\github\\pi-agent-idea", home)).toBe("D:\\code\\github\\pi-agent-idea");
    expect(shortPath("C:\\Users\\Other\\file", home)).toBe("C:\\Users\\Other\\file");
  });

  // Deliberate: this is the extracted SkillsPanel implementation, byte-for-byte
  // semantics (036 FR-007 keeps it that way). A sibling dir sharing the prefix
  // characters would shorten to "~X/..." — known edge, same as 034 shipped.
  it("keeps the original prefix-match semantics (no boundary check)", () => {
    expect(shortPath("C:\\Users\\AdministratorX\\f.txt", home)).toBe("~X/f.txt");
  });

  it("passes through when homeDir is missing or empty", () => {
    const p = "/home/dev/.pi/agent";
    expect(shortPath(p, undefined)).toBe(p);
    expect(shortPath(p, "")).toBe(p);
  });

  it("keeps the bare home as just ~", () => {
    expect(shortPath("C:/Users/Administrator", home)).toBe("~");
    // Trailing slash is kept as-is (original semantics, again deliberate).
    expect(shortPath("C:/Users/Administrator/", home)).toBe("~/");
  });
});
