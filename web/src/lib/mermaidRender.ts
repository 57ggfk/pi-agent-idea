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
 * Theme (2026-11-20, real-machine review): mermaid's own "default" theme
 * paints light boxes, so in the IDE's dark theme the diagram showed WHITE
 * blocks on a dark panel while the IDE's OWN mermaid preview next to it was
 * dark — the diagram must follow the panel. The theme is read from the
 * document (`data-theme`, driven by the store) and the palette is taken from
 * the app's own CSS variables, so a diagram blends into the message bubble in
 * both themes. A theme change re-initializes mermaid and re-renders; the
 * cache is keyed by theme as well.
 *
 * State: the mermaid module is loaded lazily on the first diagram and
 * initialized exactly once per theme; rendered diagrams are cached by
 * (theme, exact source) so streaming re-renders are cheap — a partial
 * (invalid) prefix caches a failure under ITS OWN key, and the final full
 * text is a different key.
 */
export type MermaidTheme = "light" | "dark";

let mermaidPromise: Promise<(typeof import("mermaid"))["default"]> | null = null;
let initializedFor: MermaidTheme | null = null;
/** The theme name actually handed to mermaid (differs from the app theme only
 *  if the config changes) — the figure reports it, so a wrong theme is
 *  observable instead of silent. */
let initializedBuiltIn: "dark" | "default" | null = null;

/** The theme the panel is currently in (`data-theme`, set by the store). */
export function currentMermaidTheme(): MermaidTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Reads one of the app's CSS variables (the panel's own palette). */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * mermaid config for one theme: the built-in theme for the overall look,
 * with the panel's own colors on top, so the diagram does not look like a
 * foreign light-mode widget pasted into a dark bubble.
 */
function mermaidConfig(theme: MermaidTheme) {
  const dark = theme === "dark";
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: dark ? ("dark" as const) : ("default" as const),
    themeVariables: {
      // The bubble's own surface shows through — no foreign canvas rectangle.
      background: "transparent",
      primaryColor: cssVar("--bg-input", dark ? "#2b2d30" : "#ffffff"),
      primaryTextColor: cssVar("--text", dark ? "#dfe1e5" : "#1e1f22"),
      primaryBorderColor: cssVar("--border-strong", dark ? "#4e5258" : "#c9ccd0"),
      secondaryColor: cssVar("--bg-secondary", dark ? "#26282c" : "#f7f8fa"),
      tertiaryColor: cssVar("--bg-subtle", dark ? "#26282c" : "#f7f8fa"),
      lineColor: cssVar("--text-secondary", dark ? "#a0a4ab" : "#5f6673"),
      textColor: cssVar("--text", dark ? "#dfe1e5" : "#1e1f22"),
      mainBkg: cssVar("--bg-input", dark ? "#2b2d30" : "#ffffff"),
      nodeBorder: cssVar("--border-strong", dark ? "#4e5258" : "#c9ccd0"),
      clusterBkg: cssVar("--bg-secondary", dark ? "#26282c" : "#f7f8fa"),
      clusterBorder: cssVar("--border", dark ? "#393b40" : "#e0e2e5"),
      edgeLabelBackground: cssVar("--bg", dark ? "#1e1f22" : "#ffffff"),
      titleColor: cssVar("--text", dark ? "#dfe1e5" : "#1e1f22"),
      fontSize: "13px",
    },
  };
}

async function loadMermaid(theme: MermaidTheme) {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidPromise;
  // Re-initialize when the panel theme changed: mermaid reads the theme from
  // its config at render time, and the palette above is theme-derived.
  if (initializedFor !== theme) {
    const config = mermaidConfig(theme);
    mermaid.initialize(config);
    initializedFor = theme;
    initializedBuiltIn = config.theme;
  }
  return mermaid;
}

/** The mermaid theme name the last render used ("dark" | "default"). */
export function mermaidBuiltInTheme(): "dark" | "default" | null {
  return initializedBuiltIn;
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
 * by (theme, exact source text); one render per distinct key runs at a time.
 */
export async function renderMermaid(text: string, theme = currentMermaidTheme()): Promise<string | null> {
  const key = `${theme}${text}`;
  if (svgCache.has(key)) return svgCache.get(key) ?? null;
  if (inFlight.has(key)) return null;
  inFlight.add(key);
  try {
    const mermaid = await loadMermaid(theme);
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
    svgCache.set(key, value);
    return value;
  } catch {
    // US2: syntax errors degrade to the source block — cache the failure so
    // streaming does not re-render the same broken prefix every frame.
    // Belt and braces: sweep anything mermaid still leaked into <body>.
    sweepOrphanErrorNodes();
    svgCache.set(key, null);
    return null;
  } finally {
    inFlight.delete(key);
  }
}
