import { describe, expect, it } from "vitest";
import { findTokens, removeRange, tokenBackspaceAt } from "./inlineChips";

describe("findTokens", () => {
  it("finds a token at the start", () => {
    expect(findTokens("@src/a.ts")).toEqual([{ start: 0, end: 9, path: "src/a.ts" }]);
  });

  it("finds tokens after spaces and CJK characters", () => {
    expect(findTokens("看 @src/x.ts")).toEqual([{ start: 2, end: 11, path: "src/x.ts" }]);
    expect(findTokens("看@src/x.ts")).toEqual([{ start: 1, end: 10, path: "src/x.ts" }]);
  });

  it("reads emails as text, not tokens", () => {
    expect(findTokens("mail me at user@example.com")).toEqual([]);
  });

  it("finds multiple tokens and reports ordered ranges", () => {
    const toks = findTokens("@a @b/c");
    expect(toks).toEqual([
      { start: 0, end: 2, path: "a" },
      { start: 3, end: 7, path: "b/c" },
    ]);
  });

  it("does not treat the second @ of @@a as a token", () => {
    expect(findTokens("@@a")).toEqual([]);
  });

  it("token runs stop only at whitespace/@ — same as pi's own @ parsing", () => {
    expect(findTokens("before,@a/b.ts;after")).toEqual([
      { start: 7, end: 20, path: "a/b.ts;after" },
    ]);
  });
});

describe("removeRange", () => {
  it("removes exactly the token span", () => {
    const text = "see @src/a.ts now";
    const tok = findTokens(text)[0];
    expect(removeRange(text, tok.start, tok.end)).toBe("see  now");
  });
});

describe("tokenBackspaceAt", () => {
  it("matches a caret right at the token edge", () => {
    const toks = findTokens("@a @b/c");
    expect(tokenBackspaceAt(toks, "@a @b/c", 2)).toEqual({ start: 0, end: 2 });
    expect(tokenBackspaceAt(toks, "@a @b/c", 7)).toEqual({ start: 3, end: 7 });
  });

  it("swallows the trailing separator space from the position after it", () => {
    const text = "draft @src ";
    expect(tokenBackspaceAt(findTokens(text), text, text.length)).toEqual({
      start: 6,
      end: 11,
    });
  });

  it("does not match mid-token or outside tokens", () => {
    const toks = findTokens("@a @b/c");
    expect(tokenBackspaceAt(toks, "@a @b/c", 1)).toBeNull();
    expect(tokenBackspaceAt(toks, "@a @b/c", 5)).toBeNull();
    expect(tokenBackspaceAt(toks, "@a @b/c", 0)).toBeNull();
  });
});
