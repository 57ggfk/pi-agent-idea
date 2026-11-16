import DOMPurify from "dompurify";

/**
 * 040 FR-003: renders ```mermaid blocks to SVG in the real browser.
 *
 * Real-machine probe conclusions (2026-11-17, see run report):
 * - ESM load ~1s, render ~0.5s per diagram under JCEF OSR — viable.
 * - Syntax errors throw → the caller keeps the source code (US2 degrade).
 * - Output carries width=100% + viewBox → container CSS constrains it.
 * - foreignObject appears even with htmlLabels:false, so the SVG is
 *   sanitized here with the svg profile + foreignObject allowed (mermaid
 *   securityLevel:"strict" already escapes label HTML; script/on* are
 *   stripped by DOMPurify regardless).
 *
 * State: the mermaid module is loaded lazily on the first diagram and
 * initialized exactly once; rendered diagrams are cached by exact source so
 * streaming re-renders are cheap — a partial (invalid) prefix caches a
 * failure under ITS OWN key, and the final full text is a different key.
 */
let mermaidPromise: Promise<(typeof import("mermaid"))["default"]> | null = null;

function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "strict",
    });
    return m.default;
  });
  return mermaidPromise;
}

const svgCache = new Map<string, string | null>();
const inFlight = new Set<string>();
let seq = 0;

/**
 * Renders mermaid source to a sanitized SVG string, or null when the source
 * is invalid (caller degrades to the source code block). Results are cached
 * by exact source text; one render per distinct text runs at a time.
 */
export async function renderMermaid(text: string): Promise<string | null> {
  if (svgCache.has(text)) return svgCache.get(text) ?? null;
  if (inFlight.has(text)) return null;
  inFlight.add(text);
  try {
    const mermaid = await loadMermaid();
    const id = `pi-mermaid-${++seq}`;
    const { svg } = await mermaid.render(id, text);
    const clean = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ["foreignObject"],
      ADD_ATTR: ["viewBox", "xmlns", "xmlns:xlink", "style", "transform-origin"],
    });
    const value = clean.includes("<svg") ? clean : null;
    svgCache.set(text, value);
    return value;
  } catch {
    // US2: syntax errors degrade to the source block — cache the failure so
    // streaming does not re-render the same broken prefix every frame.
    svgCache.set(text, null);
    return null;
  } finally {
    inFlight.delete(text);
  }
}
