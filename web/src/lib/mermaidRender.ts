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
 * 040 #5 (feedback batch): when parse/render throws, mermaid's own error
 * rendering leaves an orphan node (`id^=pi-mermaid-N`, div or svg) as a
 * DIRECT child of `<body>` — outside `.message-list`, unconstrained by our
 * figure container, one per failed source, so streaming accumulates them
 * (real-machine probe: `bodyKids` grew with `Syntax error in text`). Only
 * direct body children are swept: diagrams rendered into messages live in
 * `.mermaid-figure` and are never direct body children.
 */
function sweepOrphanErrorNodes() {
  for (const el of Array.from(document.body.children)) {
    if (/^pi-mermaid-/.test(el.id)) el.remove();
  }
}

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
    // 040 #5: parse BEFORE render. mermaid.render injects its error node
    // into <body> before throwing, so broken source must never reach it —
    // a rejected parse is our own degrade signal, no DOM side effects.
    await mermaid.parse(text);
    const id = `pi-mermaid-${++seq}`;
    const { svg } = await mermaid.render(id, text);
    const clean = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ["foreignObject"],
      ADD_ATTR: ["viewBox", "xmlns", "xmlns:xlink", "style", "transform-origin"],
    });
    // 040 #5, second leak path: mermaid 12 does not always throw on broken
    // source — render() sometimes RESOLVES with its own error diagram
    // ("Syntax error in text"). Treat that as a failure too, or the error
    // diagram gets cached as a valid figure and shown inside the message.
    const value = clean.includes("<svg") && !clean.includes("Syntax error in text") ? clean : null;
    svgCache.set(text, value);
    return value;
  } catch {
    // US2: syntax errors degrade to the source block — cache the failure so
    // streaming does not re-render the same broken prefix every frame.
    // Belt and braces: sweep anything mermaid still leaked into <body>.
    sweepOrphanErrorNodes();
    svgCache.set(text, null);
    return null;
  } finally {
    inFlight.delete(text);
  }
}
