import { describe, expect, it } from "vitest";
import { marked } from "marked";
import markedFootnote from "marked-footnote";

/**
 * 038 US2/FR-003: the footnote pipeline must turn `[^n]` refs into sup
 * anchors and collect `[^n]:` definitions into a footnotes section — no raw
 * `[^n]` markers left in the HTML. (DOM-level assertions — DOMPurify, sup
 * styling, in-page jump — live in the e2e suite; vitest runs without DOM.)
 */
describe("marked-footnote pipeline (038)", () => {
  marked.use(markedFootnote());

  it("renders a sup ref and a footnotes section, with no raw [^1] text", () => {
    const html = marked.parse("See the design[^1] for details.\n\n[^1]: The design document.") as string;
    expect(html).toContain('<sup><a id="footnote-ref-1" href="#footnote-1"');
    expect(html).toContain('id="footnote-1"');
    expect(html).toContain("The design document.");
    expect(html).toContain('class="footnotes"');
    expect(html).not.toContain("[^1]");
  });

  it("supports multiple and named footnotes", () => {
    const html = marked.parse("A[^1] and B[^note].\n\n[^1]: first\n[^note]: second") as string;
    expect(html).toContain('href="#footnote-1"');
    expect(html).toContain('href="#footnote-note"');
    expect(html).toContain("first");
    expect(html).toContain("second");
    expect(html).not.toContain("[^note]");
  });

  it("leaves plain text untouched when there are no footnotes", () => {
    const html = marked.parse("Just a normal paragraph.") as string;
    expect(html).toContain("Just a normal paragraph.");
    expect(html).not.toContain("footnotes");
  });

  it("does not break ordinary fenced code blocks", () => {
    const html = marked.parse("```bash\necho hi\n```") as string;
    expect(html).toContain("<pre><code");
    expect(html).not.toContain("footnotes");
  });
});

import { normalizeFootnoteDefs } from "./footnotePreprocess";

/** Real-machine finding (0.5.10 probe r1): definitions glued to the sentence
 *  above must still render — the pre-pass splits them into their own block. */
describe("normalizeFootnoteDefs (038 real-machine robustness)", () => {
  it("splits a single-newline definition into its own block so it renders", () => {
    const src = "This is a sentence.[^n1]\n[^n1]: body text\n";
    const fixed = normalizeFootnoteDefs(src);
    expect(fixed).toBe("This is a sentence.[^n1]\n\n[^n1]: body text\n");
    const html = marked.parse(fixed) as string;
    expect(html).toContain("data-footnote-ref");
    expect(html).not.toContain("[^n1]");
  });

  it("leaves well-formed input unchanged", () => {
    const src = "ref[^a]\n\n[^a]: ok\n";
    expect(normalizeFootnoteDefs(src)).toBe(src);
  });

  it("never touches definition-like lines inside fenced code", () => {
    const src = "```text\n[^x]: not a footnote\n```";
    expect(normalizeFootnoteDefs(src)).toBe(src);
  });

  it("handles CRLF; a definition at the very start is already a block", () => {
    expect(normalizeFootnoteDefs("[^a]: first\r\nline2")).toBe("[^a]: first\nline2");
    expect(normalizeFootnoteDefs("text[^a]\r\n[^a]: body")).toBe("text[^a]\n\n[^a]: body");
  });
});
