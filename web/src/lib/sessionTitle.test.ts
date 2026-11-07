import { describe, expect, test } from "vitest";
import { deriveSessionTitle, SESSION_TITLE_MAX, validateSessionTitle } from "./sessionTitle";

/** T109 (012 US1): the fallback title generator. pi does not auto-name
 *  sessions (T101 evidence), so the plugin derives the title from the first
 *  user message: whitespace collapsed, CJK/emoji counted per code point,
 *  hard length limit, exactly one call per session. */

describe("deriveSessionTitle", () => {
  test("plain short message passes through", () => {
    expect(deriveSessionTitle("Fix the login bug")).toBe("Fix the login bug");
  });

  test("newlines and repeated whitespace collapse to single spaces", () => {
    expect(deriveSessionTitle("line one\nline  two\t\tthree")).toBe("line one line two three");
  });

  test("overlong messages truncate at the limit with the marker", () => {
    const out = deriveSessionTitle("x".repeat(80))!;
    expect([...out]).toHaveLength(SESSION_TITLE_MAX + 1); // + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  test("CJK counts per character, not per UTF-16 unit", () => {
    const text = "重构".repeat(20); // 40 chars
    const out = deriveSessionTitle(text)!;
    expect([...out]).toHaveLength(SESSION_TITLE_MAX + 1);
    expect(out.startsWith("重构重构")).toBe(true);
  });

  test("emoji never splits a surrogate pair", () => {
    const text = "🚀".repeat(SESSION_TITLE_MAX + 5);
    const out = deriveSessionTitle(text)!;
    expect([...out]).toHaveLength(SESSION_TITLE_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
    for (const ch of out.replace(/…$/, "")) expect(ch.codePointAt(0)!).toBeGreaterThan(0xFFFF);
  });

  test("an expanded skill message titles with the user question (plan D1: userMessage first)", () => {
    const expanded =
      '<skill name="demo" location="/tmp/x/SKILL.md">\nbody\n</skill>\n\nhow do I use it?';
    expect(deriveSessionTitle(expanded)).toBe("how do I use it?");
  });

  test("a bare skill reference titles with the marker alone", () => {
    expect(deriveSessionTitle('<skill name="demo" location="/tmp/x/SKILL.md">\nbody\n</skill>')).toBe(
      "/skill:demo",
    );
  });

  test("empty and whitespace-only messages produce no title", () => {
    expect(deriveSessionTitle("")).toBeNull();
    expect(deriveSessionTitle("   \n\t ")).toBeNull();
  });
});

describe("validateSessionTitle", () => {
  test("empty or whitespace-only names are rejected", () => {
    expect(validateSessionTitle("")).toBe("empty");
    expect(validateSessionTitle("   ")).toBe("empty");
  });

  test("at the limit is fine, past it is too long", () => {
    expect(validateSessionTitle("中".repeat(SESSION_TITLE_MAX))).toBe("ok");
    expect(validateSessionTitle("中".repeat(SESSION_TITLE_MAX + 1))).toBe("long");
  });

  test("trimmed names are accepted", () => {
    expect(validateSessionTitle("  my session  ")).toBe("ok");
  });
});
