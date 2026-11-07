import { describe, expect, test } from "vitest";
import { displaySkillText, isSkillExpanded, parseSkillBlock } from "./skillDisplay";

/** T014 (011 US4): skill-expansion folding. The packet shape is the branch-b
 *  contract captured in /tmp/pi-forensics (T001, pi 1.4.0): pi rewrites the
 *  user message into ONE text block —
 *  `<skill name="…" location="…">\n<references line>\n\n<body>\n</skill>\n\n<user args>`
 *  — with the raw `/skill:` command nowhere on disk. pi's own parser is
 *  `/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/`;
 *  the plugin folds with the same rule, so anything else passes through. */

const EXPANDED = [
  '<skill name="forensics-demo" location="/tmp/pi-forensics/forensics-demo.md">',
  "References are relative to /tmp/pi-forensics.",
  "",
  "# Forensics Demo",
  "",
  "FORENSICS-SKILL-BODY-MARKER-XYZ123",
  "",
  "This body exists purely to be located verbatim inside the expanded user message.",
  "</skill>",
  "",
  "这是什么",
].join("\n");

describe("parseSkillBlock", () => {
  test("parses the real expanded form: name, location, body, user text", () => {
    const parsed = parseSkillBlock(EXPANDED);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("forensics-demo");
    expect(parsed!.location).toBe("/tmp/pi-forensics/forensics-demo.md");
    expect(parsed!.content).toContain("FORENSICS-SKILL-BODY-MARKER-XYZ123");
    expect(parsed!.content).not.toContain("<skill");
    expect(parsed!.userMessage).toBe("这是什么");
  });

  test("no user args → userMessage is empty (prompt with bare /skill:name)", () => {
    const bare = '<skill name="s" location="/p/SKILL.md">\nbody\n</skill>';
    const parsed = parseSkillBlock(bare);
    expect(parsed).not.toBeNull();
    expect(parsed!.userMessage).toBe("");
  });

  test("multi-paragraph body with blank lines survives ([\\s\\S]*? is non-greedy)", () => {
    const text = '<skill name="s" location="/p/SKILL.md">\npara1\n\npara2\n\npara3\n</skill>\n\ndo it';
    const parsed = parseSkillBlock(text)!;
    expect(parsed.content).toBe("para1\n\npara2\n\npara3");
    expect(parsed.userMessage).toBe("do it");
  });

  test("ordinary messages return null (no boundary markers)", () => {
    expect(parseSkillBlock("fix the failing tests")).toBeNull();
    expect(parseSkillBlock("The word skill appears here, and <skill> too.")).toBeNull();
    expect(parseSkillBlock("")).toBeNull();
  });

  test("handwritten look-alikes are NOT recognized (FR-015)", () => {
    // missing the newline before </skill>
    expect(parseSkillBlock('<skill name="s" location="/p">body</skill>')).toBeNull();
    // closing tag not on its own line
    expect(parseSkillBlock('<skill name="s" location="/p">\nbody\n</skill> trailing')).toBeNull();
    // open tag with the \n\n separator but no closing structure
    expect(parseSkillBlock('<skill name="s" location="/p">\nbody\n\narg')).toBeNull();
    // no location attribute
    expect(parseSkillBlock('<skill name="s">\nbody\n</skill>\n\narg')).toBeNull();
  });
});

describe("displaySkillText", () => {
  test("expanded message folds to the reference marker + user question", () => {
    expect(displaySkillText(EXPANDED)).toBe("/skill:forensics-demo 这是什么");
  });

  test("bare reference folds to the marker alone", () => {
    expect(displaySkillText('<skill name="s" location="/p/SKILL.md">\nbody\n</skill>')).toBe("/skill:s");
  });

  test("ordinary text passes through character-exact", () => {
    const raw = "line 1\nline 2\n";
    expect(displaySkillText(raw)).toBe(raw);
  });

  test("handwritten similar text is untouched", () => {
    const raw = 'I wrote <skill name="fake" location="/x">\nmy own\n</skill>\n\nby hand';
    expect(displaySkillText(raw)).toBe(raw);
  });

  test("each of several skill messages folds independently (multi-skill session)", () => {
    const first = '<skill name="a" location="/a/SKILL.md">\nA body\n</skill>\n\nfirst ask';
    const second = '<skill name="b" location="/b/SKILL.md">\nB body\n</skill>\n\nsecond ask';
    expect(displaySkillText(first)).toBe("/skill:a first ask");
    expect(displaySkillText(second)).toBe("/skill:b second ask");
  });
});

describe("isSkillExpanded", () => {
  test("true only for the exact expanded shape", () => {
    expect(isSkillExpanded(EXPANDED)).toBe(true);
    expect(isSkillExpanded("plain text")).toBe(false);
    expect(isSkillExpanded("mentioning /skill:demo in prose")).toBe(false);
  });
});
