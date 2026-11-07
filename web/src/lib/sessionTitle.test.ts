import { describe, expect, test } from "vitest";
import {
  clipTitleInput,
  deriveSessionTitle,
  sanitizeLlmTitle,
  SESSION_TITLE_MAX,
  validateSessionTitle,
} from "./sessionTitle";

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

  // IDE scaffold prompts (PiEditorActions.kt / DirectoryListing.kt): the
  // composer prefills them verbatim, so a first message can be pure
  // boilerplate — the title comes from the subject, not the plumbing sentence.
  test("the add-directory prompt titles with the path, not the boilerplate", () => {
    const prompt =
      "Here is the directory `src` (1 file, 0 subdirectories):\n\nsrc/Main.java\n\nRead whatever you need.";
    expect(deriveSessionTitle(prompt)).toBe("Directory: src");
  });

  test("a question typed after the directory trailer beats the subject", () => {
    const prompt =
      "Here is the directory `src` (1 file, 0 subdirectories):\n\nsrc/Main.java\n\nRead whatever you need.\n哪个文件是入口？";
    expect(deriveSessionTitle(prompt)).toBe("哪个文件是入口？");
  });

  test("explain/fix/send-selection scaffolds title with verb and target", () => {
    expect(deriveSessionTitle("Look at `src/Main.java`. Summarize what this file does.")).toBe(
      "Explain: src/Main.java",
    );
    expect(deriveSessionTitle("Look at the directory `sub`. Summarize its structure.")).toBe("Explain: sub");
    expect(
      deriveSessionTitle("Explain the following code from `src/Main.java:12` (concise):\n```java\nx\n```"),
    ).toBe("Explain: src/Main.java:12");
    expect(deriveSessionTitle("Fix the following code from `src/App.kt:3`.\n```kotlin\nx\n```")).toBe(
      "Fix: src/App.kt:3",
    );
    expect(deriveSessionTitle("Regarding `src/Main.java:42`:\n```java\nx\n```")).toBe(
      "Selection: src/Main.java:42",
    );
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

describe("sanitizeLlmTitle (B stage)", () => {
  test("strips one pair of wrapping quotes, ASCII and CJK alike", () => {
    expect(sanitizeLlmTitle('"Fix the login bug"')).toBe("Fix the login bug");
    expect(sanitizeLlmTitle("“修复登录 bug”")).toBe("修复登录 bug");
    expect(sanitizeLlmTitle("`Title here`")).toBe("Title here");
  });

  test("takes the first non-blank line and collapses whitespace", () => {
    expect(sanitizeLlmTitle("\n\n  Fix the bug  \n\nexplanation that must go")).toBe("Fix the bug");
    // the title is the first line only — anything after a newline is chatter
    expect(sanitizeLlmTitle("title with\ninternal newline")).toBe("title with");
  });

  test("caps at the shared limit with the ellipsis, per code point", () => {
    expect(sanitizeLlmTitle("x".repeat(40))).toBe("x".repeat(SESSION_TITLE_MAX) + "…");
    expect(sanitizeLlmTitle("中".repeat(40))).toBe("中".repeat(SESSION_TITLE_MAX) + "…");
  });

  test("empty or blank output is rejected so A's title survives", () => {
    expect(sanitizeLlmTitle("")).toBeNull();
    expect(sanitizeLlmTitle("  \n \n ")).toBeNull();
  });

  test("clipTitleInput clips per code point", () => {
    expect(clipTitleInput("中".repeat(5), 3)).toBe("中".repeat(3));
    expect(clipTitleInput("abc", 10)).toBe("abc");
  });
});
