import { describe, expect, it } from "vitest";
import { parseDiffHeaderPath } from "./diffPaths";

/** 041 #9: ```diff header lines → the file path they point at. */
describe("parseDiffHeaderPath", () => {
  it("reads --- / +++ lines with a/ b/ prefixes", () => {
    expect(parseDiffHeaderPath("--- a/src/circle.svg")).toBe("src/circle.svg");
    expect(parseDiffHeaderPath("+++ b/src/circle.svg")).toBe("src/circle.svg");
    expect(parseDiffHeaderPath("--- src/circle.svg")).toBe("src/circle.svg");
  });

  it("prefers the b/ path of a diff --git header", () => {
    expect(parseDiffHeaderPath("diff --git a/circle.svg b/circle.svg")).toBe("circle.svg");
    expect(parseDiffHeaderPath("diff --git a/x.ts b/y.ts")).toBe("y.ts");
  });

  it("ignores git timestamp junk after the path", () => {
    expect(parseDiffHeaderPath("+++ b/src/app.tsx\t2026-01-01 00:00:00.000000000")).toBe("src/app.tsx");
    expect(parseDiffHeaderPath("--- a/app.ts\t2026-01-01")).toBe("app.ts");
  });

  it("returns null for non-path headers and other lines", () => {
    expect(parseDiffHeaderPath("--- /dev/null")).toBe(null);
    expect(parseDiffHeaderPath("+++ /dev/null")).toBe(null);
    expect(parseDiffHeaderPath("@@ -1,2 +1,2 @@")).toBe(null);
    expect(parseDiffHeaderPath("-console.log(\"old\");")).toBe(null);
    expect(parseDiffHeaderPath("")).toBe(null);
  });

  it("keeps windows paths and bare file names", () => {
    expect(parseDiffHeaderPath("+++ b/d:\\out\\circle.svg")).toBe("d:\\out\\circle.svg");
    expect(parseDiffHeaderPath("+++ circle.svg")).toBe("circle.svg");
  });
});
