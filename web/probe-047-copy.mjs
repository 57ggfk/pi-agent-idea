#!/usr/bin/env node
// 047 FR-008 剩余探针（真实渲染块 → PNG 取图判定），页面级原生 WebSocket CDP。
//   node probe-047-copy.mjs probe   — mermaid foreignObject 保真 + KaTeX 内联字体像素判定
// 证据 JSON 落 OUT。
import { writeFileSync } from "node:fs";

const CDP_HTTP = process.env.FB_CDP || "http://127.0.0.1:9222";
const STAGE = process.argv[2] || "probe";
const OUT = process.env.FB_OUT || `C:/Users/Administrator/AppData/Local/Temp/fb-047-${STAGE}.json`;
const report = { stage: STAGE, at: new Date().toISOString(), cdp: CDP_HTTP };

async function listPages() {
  const res = await fetch(`${CDP_HTTP}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list -> ${res.status}`);
  const all = await res.json();
  return all.filter((p) => p.type === "page" && /token=/.test(p.url) && /127\.0\.0\.1/.test(p.url))
    .map((p) => ({ ...p, wsSafe: `ws://127.0.0.1:9222/devtools/page/${p.id}` }));
}

function openPageSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let next = 1;
    const t = setTimeout(() => reject(new Error("ws open timeout")), 8000);
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = next++;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 120000);
      pending.set(id, { resolve: res, reject: rej, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener("open", () => { clearTimeout(t); resolve({ send, close: () => ws.close() }); });
    ws.addEventListener("error", (e) => { clearTimeout(t); reject(new Error(`ws error: ${e?.message || wsUrl}`)); });
    ws.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (!m.id || !pending.has(m.id)) return;
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
    });
  });
}

async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval failed"));
  return r.result?.value;
}

/** The page-side probe: runs in the JCEF page, returns go/no-go evidence. */
const PAGE_PROBE = `(async () => {
  const out = {};
  // 画布小工具：把 svg 字符串画进 canvas，返回 dataURL 与非透明像素占比。
  async function rasterize(svgString, width, height) {
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('img error')); img.src = url; });
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const data = c.toDataURL('image/png');
    // 统计非白像素比例
    const d = ctx.getImageData(0, 0, width, height).data;
    let inked = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 250 || d[i+1] < 250 || d[i+2] < 250) inked++;
    }
    return { data, inkedRatio: inked / (width * height) };
  }

  // ---- 1) mermaid/SVG foreignObject（label 文字）在 img-SVG 中是否保真
  const W = 200, H = 80;
  const withLabel = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">' +
    '<foreignObject width="' + W + '" height="' + H + '"><div xmlns="http://www.w3.org/1999/xhtml"' +
    ' style="font: 24px sans-serif; color: #000;">Start</div></foreignObject></svg>';
  const withoutLabel = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"></svg>';
  try {
    const a = await rasterize(withLabel, W, H);
    const b = await rasterize(withoutLabel, W, H);
    out.foreignObjectLabel = { inkedWith: +a.inkedRatio.toFixed(4), inkedWithout: +b.inkedRatio.toFixed(4),
      rendered: a.inkedRatio > 0.01, faithful: a.inkedRatio > b.inkedRatio * 3 };
  } catch (e) { out.foreignObjectLabel = { error: String(e) }; }

  // ---- 2) KaTeX：取真实渲染的 .katex DOM，foreignObject + 内联 CSS/字体 方案像素判定
  const katexEl = document.querySelector('.katex');
  out.katexPresent = !!katexEl;
  if (katexEl) {
    const wrap = (inner, styleText) =>
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80">' +
      '<foreignObject width="320" height="80"><div xmlns="http://www.w3.org/1999/xhtml" style="' + styleText + '">' +
      inner + '</div></foreignObject></svg>';
    // 收集页面加载的 CSS（KaTeX 样式在打包 css 里），字体重写为 data URL
    let cssText = '';
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          const t = rule.cssText || '';
          if (/katex|KaTeX/i.test(t)) cssText += t + '\\n';
        }
      } catch (e) { /* cross-origin */ }
    }
    // 提取 url(...) 字体并 fetch 为 data URL（同源打包产物）
    const urls = [...new Set([...cssText.matchAll(/url\\(["']?([^)"']+\\.woff2?)["']?\\)/g)].map(m => m[1]))];
    let fontCss = cssText;
    const fetched = [];
    for (const u of urls) {
      try {
        const res = await fetch(new URL(u, location.href).href);
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        const b64 = btoa(binary);
        fontCss = fontCss.split(u).join('data:font/woff2;base64,' + b64);
        fetched.push({ url: u, bytes: bytes.length });
      } catch (e) { fetched.push({ url: u, error: String(e) }); }
    }
    out.katexFonts = { candidates: urls.length, fetched: fetched.filter(f => f.bytes).length, sampleBytes: fetched[0]?.bytes };
    const inner = katexEl.outerHTML;
    const styleTag = '<style>' + fontCss.replace(/<\\/?.[^>]*>/g, '') + '</style>';
    try {
      const withFonts = await rasterize(wrap(styleTag + inner, 'background:#fff;padding:8px;'), 320, 80);
      const noFonts = await rasterize(wrap('<style>' + cssText.replace(/<\\/?.[^>]*>/g, '').split('src:url').join('src:x:url') + '</style>' + inner, 'background:#fff;padding:8px;'), 320, 80);
      // 像素差异：字体生效与否会改变 glyph 形状/宽度
      let diff = 0;
      const da = withFonts.data, db = noFonts.data;
      // 粗判：非白像素量差异 + dataURL 不同
      out.katexProbe = {
        inkedWithFonts: +withFonts.inkedRatio.toFixed(4),
        inkedNoFonts: +noFonts.inkedRatio.toFixed(4),
        dataUrlDiffers: da !== db,
        fontsApplied: da !== db && Math.abs(withFonts.inkedRatio - noFonts.inkedRatio) > 0.005,
      };
    } catch (e) { out.katexProbe = { error: String(e) }; }
  }
  return out;
})()`;

(async () => {
  try {
    const pages = await listPages();
    if (!pages.length) throw new Error("no Pi Agent page target — tool window open?");
    const { send, close } = await openPageSocket(pages[0].wsSafe || pages[0].ws);
    try {
      report.result = await evaluate(send, PAGE_PROBE);
      report.ok = true;
    } finally {
      close();
    }
  } catch (e) {
    report.ok = false;
    report.error = String(e?.stack || e);
  }
  writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
})();
