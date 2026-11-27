import { describe, expect, it } from "vitest";
import {
  expandPastes,
  hasPasteTokens,
  pasteToken,
  replaceToken,
  scanPasteTokens,
  type PasteTokenWords,
} from "./pasteCollapse";

/**
 * Issue #11 — the folded-paste placeholder was hardcoded English.
 *
 * The token is a RESTORE KEY: the draft is expanded back to the original
 * content right before sending. So the wording may be localized, but the
 * token must stay recognizable — a token created in the English UI has to
 * survive a switch to Chinese (and the other way round), or the user's
 * paste would be sent as a literal "[已粘贴 …]" string.
 */

const EN: PasteTokenWords = {
  pasted: "Pasted",
  lines: "lines",
  kinds: { Markdown: "Markdown", JSON: "JSON", code: "code", log: "log", text: "text" },
};

const ZH: PasteTokenWords = {
  pasted: "已粘贴",
  lines: "行",
  kinds: { Markdown: "Markdown", JSON: "JSON", code: "代码", log: "日志", text: "文本" },
};

describe("issue #11 — the paste token is localized", () => {
  it("the Chinese UI writes a Chinese placeholder", () => {
    expect(pasteToken(1, "Markdown", 18, ZH)).toBe("[已粘贴 Markdown #1 +18 行]");
    expect(pasteToken(2, "code", 3, ZH)).toBe("[已粘贴 代码 #2 +3 行]");
  });

  it("the English UI still writes the English placeholder", () => {
    expect(pasteToken(1, "Markdown", 18, EN)).toBe("[Pasted Markdown #1 +18 lines]");
  });

  it("the machine core is byte-identical in every language", () => {
    const en = pasteToken(7, "text", 42, EN);
    const zh = pasteToken(7, "text", 42, ZH);
    // The restore key — the id and the line count — does not move.
    expect(en).toContain("#7 +42 ");
    expect(zh).toContain("#7 +42 ");
    expect(scanPasteTokens(en)[0]?.id).toBe(scanPasteTokens(zh)[0]?.id);
    expect(scanPasteTokens(en)[0]?.lines).toBe(scanPasteTokens(zh)[0]?.lines);
  });

  it("an English token is still recognized after the UI switched to Chinese", () => {
    const token = pasteToken(3, "Markdown", 12, EN);
    const found = scanPasteTokens(`before ${token} after`);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(3);
    expect(found[0]?.lines).toBe(12);
    expect(found[0]?.text).toBe(token);
    // And it still expands back to the original content.
    expect(expandPastes(`before ${token} after`, new Map([[3, "full text"]]))).toBe(
      "before full text after",
    );
  });

  it("a Chinese token is still recognized after the UI switched to English", () => {
    const token = pasteToken(4, "code", 5, ZH);
    const found = scanPasteTokens(token);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(4);
    expect(found[0]?.lines).toBe(5);
    expect(expandPastes(token, new Map([[4, "const a = 1;"]]))).toBe("const a = 1;");
  });

  it("hasPasteTokens and replaceToken keep working for both languages", () => {
    const en = pasteToken(1, "JSON", 2, EN);
    const zh = pasteToken(2, "JSON", 2, ZH);
    expect(hasPasteTokens(en)).toBe(true);
    expect(hasPasteTokens(zh)).toBe(true);
    expect(replaceToken(`a ${en} b`, 1, "X")?.text).toBe("a X b");
    expect(replaceToken(`a ${zh} b`, 2, "X")?.text).toBe("a X b");
  });

  it("the scanner reports the token bounds, so the chip layer stays aligned", () => {
    const token = pasteToken(9, "text", 4, ZH);
    const draft = `head ${token} tail`;
    const found = scanPasteTokens(draft);
    expect(found).toHaveLength(1);
    expect(found[0]?.start).toBe(5);
    expect(found[0]?.end).toBe(5 + token.length);
    expect(draft.slice(found[0]!.start, found[0]!.end)).toBe(token);
  });

  it("plain prose is not mistaken for a token", () => {
    expect(hasPasteTokens("nothing to see here")).toBe(false);
    expect(scanPasteTokens("[not a token]")).toHaveLength(0);
  });
});
