import { describe, expect, it } from "vitest";
import {
  collectPathRefs,
  fileRefsFromEntries,
  looksLikePath,
  parseUriList,
  pathLikeTextRef,
} from "./clipboardRefs";

describe("looksLikePath", () => {
  it.each(["/usr/bin/env", "./gradlew", "../src", "~/x", "C:\\Users", "C:/x"])(
    "accepts path-looking %s",
    (t) => expect(looksLikePath(t)).toBe(true),
  );
  it.each(["fun", "main()", "src", "npm:@scope/pkg", "https://x", "—— 分割 ——"])(
    "rejects non-path %s",
    (t) => expect(looksLikePath(t)).toBe(false),
  );
});

describe("pathLikeTextRef (018 US3)", () => {
  it("accepts a single whitespace-free path-looking line", () => {
    expect(pathLikeTextRef("/usr/local/bin/pi")).toEqual({ path: "/usr/local/bin/pi", dir: false });
    expect(pathLikeTextRef("  ./gradlew  ")).toEqual({ path: "./gradlew", dir: false });
    expect(pathLikeTextRef("~/docs/")).toEqual({ path: "~/docs/", dir: true });
  });

  it("rejects multi-line markdown even when lines look like paths", () => {
    const md = "# title\n./gradlew buildPlugin\nsee /usr/local/bin/pi";
    expect(pathLikeTextRef(md)).toBeNull();
  });

  it("rejects a single line containing whitespace (command with args)", () => {
    expect(pathLikeTextRef("./gradlew buildPlugin")).toBeNull();
  });

  it("rejects non-path single lines and email addresses", () => {
    expect(pathLikeTextRef("user@example.com")).toBeNull();
    expect(pathLikeTextRef("hello world")).toBeNull();
    expect(pathLikeTextRef("")).toBeNull();
  });
});

describe("parseUriList", () => {
  it("parses file:// lines, keeps order, skips comments and non-file URIs", () => {
    const refs = parseUriList(
      "# comment\nfile:///a/b.txt\nhttps://example.com/x\nfile:///c%20d/e%20f/",
    );
    expect(refs).toEqual([
      { path: "/a/b.txt", dir: false },
      { path: "/c d/e f/", dir: true },
    ]);
  });

  it("accepts a bare path line only when it arrives via file:// (018: no bare-path branch)", () => {
    expect(parseUriList("/usr/bin/env\n./gradlew")).toEqual([]);
  });
});

describe("fileRefsFromEntries", () => {
  const img = { name: "pic.png", fullPath: null, isDirectory: false, isImage: true };

  it("excludes images (they stay on the image-chip path)", () => {
    expect(fileRefsFromEntries([img])).toEqual([]);
  });

  it("uses multi-segment fullPath, degrades to bare name otherwise", () => {
    expect(
      fileRefsFromEntries([
        { name: "a.ts", fullPath: "/repo/src/a.ts", isDirectory: false, isImage: false },
        { name: "drop.txt", fullPath: "/drop.txt", isDirectory: false, isImage: false },
      ]),
    ).toEqual([
      { path: "/repo/src/a.ts", dir: false },
      { path: "drop.txt", dir: false },
    ]);
  });
});

describe("collectPathRefs", () => {
  const noFiles: Parameters<typeof collectPathRefs>[0] = [];

  it("prefers real file items over text flavours", () => {
    const refs = collectPathRefs(
      [{ name: "a.ts", fullPath: "/repo/a.ts", isDirectory: false, isImage: false }],
      "file:///other.txt",
      "/plain.txt",
    );
    expect(refs).toEqual([{ path: "/repo/a.ts", dir: false }]);
  });

  it("falls back to uri-list before text", () => {
    expect(collectPathRefs(noFiles, "file:///a.txt", "/b.txt")).toEqual([
      { path: "/a.txt", dir: false },
    ]);
  });

  it("applies the single-line text rule last (018 US3)", () => {
    expect(collectPathRefs(noFiles, "", "/single/path")).toEqual([{ path: "/single/path", dir: false }]);
    // The markdown misfire from the defect report: many path-looking lines → zero refs.
    expect(collectPathRefs(noFiles, "", "# t\n./gradlew build\n/usr/bin/env node")).toEqual([]);
    expect(collectPathRefs(noFiles, "", "ordinary pasted text")).toEqual([]);
  });
});
