/**
 * 047: renders a message's graphic block to a PNG data URL, entirely in the
 * frontend (FR-004). No format is converted into another one first — the
 * probe (probe-047-copy.mjs, 2026-11-18) pinned the two real paths:
 *
 * - SVG / Mermaid render as `<svg>`: serialize and draw through an Image into
 *   a canvas. foreignObject labels survive (probe: inked 2.9% vs 0% without).
 * - KaTeX is HTML+MathML: wrapped into a foreignObject `<svg>` with the
 *   page's KaTeX CSS and its @font-face resources inlined as data URLs — the
 *   probe shows the bitmaps differ with fonts fetched (dataUrlDiffers=true),
 *   i.e. the fonts apply inside the img-SVG context.
 *
 * All PNGs get a white backdrop: the panel renders on the IDE light theme, so
 * the copy matches what the user sees and stays visible on any paste target.
 * The clipboard channel is the 012 `ide.copyImage` bridge (Q3 复核: a CDP-side
 * direct `navigator.clipboard.write` cannot pass the focus check — the bridge
 * is the machine-verified path; both sides add no new bridge method).
 */

const FONT_DATA_URL_CACHE = new Map<string, string>();

const PNG_MAX_SIDE = 2000;

/** Collects the page's CSS that matches `filter`, fonts rewritten to data URLs. */
async function inlinedCss(filter: RegExp): Promise<string> {
  let css = "";
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList | undefined;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet — never ours, skip
    }
    if (!rules) continue;
    for (const rule of rules) {
      const text = rule.cssText ?? "";
      if (filter.test(text)) css += text + "\n";
    }
  }
  const urls = [...new Set([...css.matchAll(/url\(["']?([^)"']+\.woff2?)["']?\)/g)].map((m) => m[1]))];
  for (const url of urls) {
    let dataUrl = FONT_DATA_URL_CACHE.get(url);
    if (dataUrl === undefined) {
      dataUrl = "";
      try {
        const res = await fetch(new URL(url, location.href).href);
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
          }
          dataUrl = `data:font/woff2;base64,${btoa(binary)}`;
        }
      } catch {
        dataUrl = ""; // font fetch failure degrades to the fallback glyphs
      }
      FONT_DATA_URL_CACHE.set(url, dataUrl);
    }
    if (dataUrl) css = css.split(url).join(dataUrl);
  }
  return css;
}

function drawToPng(img: HTMLImageElement, width: number, height: number): string {
  const scale = Math.min(2, PNG_MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

/** SVG path (039 inline SVG / 040 Mermaid figure): serialize → Image → canvas. */
async function rasterizeSvg(svg: SVGElement): Promise<string> {
  const rect = svg.getBoundingClientRect();
  const width = Math.round(rect.width || parseFloat(svg.getAttribute("width") || "") || 300);
  const height = Math.round(rect.height || parseFloat(svg.getAttribute("height") || "") || 150);
  const clone = svg.cloneNode(true) as SVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const xml = new XMLSerializer().serializeToString(clone);
  const img = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml));
  return drawToPng(img, width, height);
}

/**
 * HTML path (040 KaTeX): foreignObject wrapper + the block's CSS (KaTeX rules
 * incl. data-URL fonts) inlined, then the same Image → canvas draw.
 */
async function rasterizeHtml(el: HTMLElement): Promise<string> {
  const rect = el.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width) + 16);
  const height = Math.max(1, Math.round(rect.height) + 16);
  const css = await inlinedCss(/katex/i);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="background:#ffffff;padding:8px;font:14px/1.4 sans-serif;">` +
    `<style>${css.replace(/<\/?[a-z][^>]*>/gi, "")}</style>` +
    el.outerHTML +
    `</div></foreignObject></svg>`;
  const img = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
  return drawToPng(img, width, height);
}

/** Dispatches on the block kind; throws when the block cannot be rasterized. */
export async function rasterizeElement(el: Element): Promise<string> {
  if (el instanceof SVGElement) return rasterizeSvg(el);
  if (el instanceof HTMLElement) return rasterizeHtml(el);
  throw new Error("unsupported block for copy-as-image");
}

/**
 * Pure part for the unit tests: the SVG string builder for the HTML path —
 * the wrapper shape (styles inlined, tags stripped from cssText, white
 * backdrop) is where the fidelity risk lives.
 */
export function buildHtmlWrapper(inner: string, css: string, width: number, height: number): string {
  const stripped = css.replace(/<\/?[a-z][^>]*>/gi, "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="background:#ffffff;padding:8px;font:14px/1.4 sans-serif;">` +
    `<style>${stripped}</style>` +
    inner +
    `</div></foreignObject></svg>`
  );
}

/** Pure: the canvas size for a rendered block (2x until the cap). */
export function pngCanvasSize(width: number, height: number): { w: number; h: number } {
  const scale = Math.min(2, PNG_MAX_SIDE / Math.max(width, height));
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}
