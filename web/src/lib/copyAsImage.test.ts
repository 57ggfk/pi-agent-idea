import { describe, expect, it } from "vitest";
import { buildHtmlWrapper, pngCanvasSize } from "./copyAsImage";

/**
 * 047: the pure parts of the rasterizer. The canvas/Image paths are
 * browser-only — their fidelity is pinned by the real-machine probe
 * (probe-047-copy.mjs) and the run-report's real-machine click-through.
 */
describe("pngCanvasSize", () => {
  it("scales 2x for small blocks", () => {
    expect(pngCanvasSize(200, 80)).toEqual({ w: 400, h: 160 });
  });

  it("caps the longest side at 2000 and keeps aspect", () => {
    expect(pngCanvasSize(3000, 1500)).toEqual({ w: 2000, h: 1000 });
    expect(pngCanvasSize(4000, 100)).toEqual({ w: 2000, h: 50 });
  });

  it("never returns a zero side", () => {
    expect(pngCanvasSize(0, 0)).toEqual({ w: 1, h: 1 });
  });
});

describe("buildHtmlWrapper", () => {
  it("wraps the block in a foreignObject svg with a white backdrop", () => {
    const svg = buildHtmlWrapper("<span class=\"katex\">x</span>", "", 320, 80);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("foreignObject");
    expect(svg).toContain("background:#ffffff");
    expect(svg).toContain('width="320" height="80"');
    expect(svg).toContain('<span class="katex">x</span>');
  });

  it("strips markup tags from the inlined css text", () => {
    const svg = buildHtmlWrapper("x", "@font-face { src: url(a.woff2); } <style>bad</style>", 10, 10);
    expect(svg).not.toContain("<style>bad</style>");
    expect(svg).toContain("src: url(a.woff2);");
  });
});
