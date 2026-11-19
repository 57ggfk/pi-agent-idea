import { describe, expect, it } from "vitest";
import { marked } from "marked";
import { matchesExtendedInline, markedKatexExtended } from "./katexInline";

// Register the way the app does (`marked.use`), not through a parse option —
// marked ignores `extensions` in the per-call options. vitest isolates module
// registries per test file, so the global instance is safe to configure here.
marked.use(markedKatexExtended({ throwOnError: false }));
marked.setOptions({ gfm: true, breaks: true });

function render(src: string): string {
  return marked.parse(src) as string;
}

const isMath = (html: string) => html.includes('class="katex"');

describe("040 revision: the trailing characters after the closing $", () => {
  it("renders the formula when the closing $ is followed by a semicolon", () => {
    expect(isMath(render("因此 $E=mc^2$；"))).toBe(true);
    expect(isMath(render("thus $E=mc^2$;"))).toBe(true);
  });

  it("renders when the closing $ is followed by a closing bracket or quote", () => {
    for (const tail of [")", "）", "]", "】", "、", "」", "”", "’", "/", "+", "="]) {
      expect(isMath(render(`公式 $x$${tail}`)), `tail=${tail}`).toBe(true);
    }
  });

  it("keeps the upstream behaviour for the characters it already allowed", () => {
    for (const tail of ["", " ", ".", ",", ":", "?", "!", "。", "，", "：", "？", "！"]) {
      expect(isMath(render(`公式 $x$${tail}`)), `tail=${tail}`).toBe(true);
    }
  });

  it("does NOT turn currency into a formula", () => {
    // The closing $ here is followed by a digit — that is what keeps the
    // "money" case out, and it must survive the relaxation.
    expect(isMath(render("价格 $5 到 $10"))).toBe(false);
    expect(isMath(render("cost $100"))).toBe(false);
  });

  it("does not treat a $ that follows a word character as math", () => {
    // Upstream rule 1: the opening $ must sit at the start or after a space.
    expect(isMath(render("变量$x$ 后面"))).toBe(false);
  });

  it("renders display math for $$…$$", () => {
    const html = render("$$\nE=mc^2\n$$");
    expect(html).toContain("katex-display");
  });

  it("exposes the relaxed rule for direct assertions", () => {
    expect(matchesExtendedInline("$E=mc^2$;")).toBe(true);
    expect(matchesExtendedInline("$5 到 $10")).toBe(false);
  });
});
