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

describe("040 revision 2: the character before the opening $", () => {
  it("renders the reported formula that follows Chinese punctuation", () => {
    // The reported case: the whole formula stayed raw text because the
    // opening $ followed a full-width colon, not a space.
    const html = render("素数定理：$\\pi(x)\\sim\\frac{x}{\\ln x}$");
    expect(isMath(html)).toBe(true);
    expect(html).not.toContain("$\\pi(x)");
  });

  it("renders a formula that follows punctuation of any kind", () => {
    for (const lead of ["素数定理：", "（", "「", "《", "，", "。", "；", "！", "？", "…"]) {
      expect(isMath(render(`${lead}$E=mc^2$`)), `lead=${lead}`).toBe(true);
    }
  });

  it("renders a formula whose closing $ is followed by a CJK closer", () => {
    for (const tail of ["》", "〉", "］", "｝", "」", "】", "）", "、", "。", "%"]) {
      expect(isMath(render(`《$E=mc^2$${tail}`)), `tail=${tail}`).toBe(true);
    }
  });

  it("still refuses a $ that touches a word character", () => {
    expect(isMath(render("变量$x$ 后面"))).toBe(false);
    expect(isMath(render("当$x>0$时"))).toBe(false);
    expect(isMath(render("售价$5$"))).toBe(false);
  });

  it("still refuses currency", () => {
    expect(isMath(render("价格 $5 到 $10"))).toBe(false);
    expect(isMath(render("cost $100"))).toBe(false);
  });

  it("does not swallow a money phrase that carries two dollar signs", () => {
    // Real-machine probe: the formula body spanned the inner $, so the whole
    // sentence became one math span and KaTeX painted it as an error.
    expect(isMath(render("价格 $5 到 $10 变量$x$"))).toBe(false);
    expect(isMath(render("预算 $100 到 $200 之内"))).toBe(false);
  });
});
