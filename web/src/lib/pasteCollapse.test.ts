import { describe, expect, it } from "vitest";
import {
  countLines,
  detectPasteKind,
  expandPastes,
  hasPasteTokens,
  pasteToken,
  replaceToken,
  type PasteTokenWords,
  shouldAutoSaveAsFile,
  shouldCollapse,
} from "./pasteCollapse";

/** 044 FR-001/FR-002/FR-003 + FR-007. */
describe("pasteCollapse thresholds", () => {
  it("short pastes (≤3 lines and ≤800 chars) do not fold", () => {
    expect(shouldCollapse("one line")).toBe(false);
    expect(shouldCollapse("a\nb\nc")).toBe(false); // exactly 3 lines
    expect(shouldCollapse("x".repeat(800))).toBe(false); // exactly 800 chars
  });

  it(">3 lines OR >800 chars folds (either suffices)", () => {
    expect(shouldCollapse("a\nb\nc\nd")).toBe(true); // 4 lines
    expect(shouldCollapse("x".repeat(801))).toBe(true); // 801 chars, 1 line
  });

  it("counts lines as newline+1 and handles CRLF", () => {
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\r\nb")).toBe(2);
    expect(countLines("")).toBe(1);
  });
});

/** 044 #4 (feedback batch): the auto-save boundary is 2000 lines exactly. */
describe("pasteCollapse auto-save threshold", () => {
  it("2000 lines stays a folded chip; 2001 auto-saves to a file", () => {
    expect(shouldAutoSaveAsFile(2000)).toBe(false);
    expect(shouldAutoSaveAsFile(2001)).toBe(true);
    expect(shouldAutoSaveAsFile(5000)).toBe(true);
  });

  it("short pastes never auto-save", () => {
    expect(shouldAutoSaveAsFile(0)).toBe(false);
    expect(shouldAutoSaveAsFile(3)).toBe(false);
  });
});

describe("pasteCollapse kind detection", () => {
  it("detects parseable JSON", () => {
    expect(detectPasteKind('{"a": 1,\n "b": [2, 3]}')).toBe("JSON");
    expect(detectPasteKind('[1, 2, 3]')).toBe("JSON");
  });

  it("detects logs by timestamps and levels", () => {
    const log = [
      "2026-11-16 23:59:01 ERROR main: boom",
      "2026-11-16 23:59:02 INFO main: ok",
      "[WARN] retrying",
    ].join("\n");
    expect(detectPasteKind(log)).toBe("log");
  });

  it("detects Markdown by headers, fences and lists", () => {
    const md = [
      "# Title",
      "- item one",
      "```",
      "code",
      "```",
    ].join("\n");
    expect(detectPasteKind(md)).toBe("Markdown");
  });

  it("detects code by syntax tokens", () => {
    const code = [
      "import { useState } from 'react';",
      "const x = (a) => {",
      "  return a + 1;",
      "};",
    ].join("\n");
    expect(detectPasteKind(code)).toBe("code");
  });

  it("falls back to text", () => {
    expect(detectPasteKind("just some prose words\nnothing special")).toBe("text");
    expect(detectPasteKind("")).toBe("text");
  });
});

/**
 * The English wording (issue #11) — the token format itself is unchanged for
 * English, the words around the machine core are what got localized.
 */
const EN_WORDS: PasteTokenWords = {
  pasted: "Pasted",
  lines: "lines",
  kinds: { Markdown: "Markdown", JSON: "JSON", code: "code", log: "log", text: "text" },
};

describe("paste tokens (FR-007)", () => {
  it("formats the stable token", () => {
    expect(pasteToken(1, "Markdown", 18, EN_WORDS)).toBe("[Pasted Markdown #1 +18 lines]");
  });

  it("expands tokens back to the full original before send", () => {
    const map = new Map([[1, { content: "line1\nline2\nline3", lines: 3 }]]);
    const draft = `check this: ${pasteToken(1, "Markdown", 3, EN_WORDS)} please`;
    expect(expandPastes(draft, map)).toBe("check this: line1\nline2\nline3 please");
  });

  it("keeps unknown tokens as-is instead of silently emptying them", () => {
    const draft = pasteToken(7, "code", 9, EN_WORDS);
    expect(expandPastes(`a ${draft} b`, new Map())).toBe(`a ${draft} b`);
  });

  it("detects and replaces single tokens", () => {
    const draft = `before ${pasteToken(2, "JSON", 5, EN_WORDS)} after`;
    expect(hasPasteTokens(draft)).toBe(true);
    const r = replaceToken(draft, 2, "REPL");
    expect(r?.text).toBe("before REPL after");
    expect(r?.start).toBe(7);
    expect(hasPasteTokens("no tokens here")).toBe(false);
  });
});
