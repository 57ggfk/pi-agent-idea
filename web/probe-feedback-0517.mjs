#!/usr/bin/env node
// 2026-11-17 真机反馈探测（040#5 / 047 / 039#6），页面级原生 WebSocket CDP。
// 只做读取/注入探测，不改产品代码、不改配置。证据 JSON 落 OUT。
//   node probe-feedback-0517.mjs mermaid   — 040#5: mermaid 语法错是否向 body 注入游离 error div/累积
//   node probe-feedback-0517.mjs capture   — 047: JCEF 取图/剪贴板技术底（canvas/clipboard/桥接）
//   node probe-feedback-0517.mjs svg       — 039#6: 裸 SVG 渲染 vs 围栏 SVG 源码边界
//   node probe-feedback-0517.mjs state     — 页面与状态侦察
import { writeFileSync } from "node:fs";

const CDP_HTTP = process.env.FB_CDP || "http://127.0.0.1:9222";
const STAGE = process.argv[2] || "state";
const OUT = process.env.FB_OUT || `C:/Users/Administrator/AppData/Local/Temp/fb-probe-${STAGE}.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 60000);
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

async function withPage(fn) {
  const pages = await listPages();
  if (!pages.length) throw new Error("no Pi Agent page target — tool window open?");
  const { send, close } = await openPageSocket(pages[0].wsSafe || pages[0].ws);
  try { return await fn(send, pages); } finally { close(); }
}

function dump(obj, label) {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(obj, null, 2));
}

async function stageState(send) {
  return evaluate(send, `(() => {
    const q = (s) => document.querySelector(s);
    return {
      url: location.href.slice(0, 90),
      hasComposer: !!q('[data-testid="composer-input"]'),
      hasTabs: !!q('[data-testid="tabs"]'),
      tabs: [...document.querySelectorAll('[data-testid^="tab-"]')].map(e => (e.textContent||'').trim()),
      messageItems: document.querySelectorAll('[data-testid="message-item"], .message-item').length,
      mermaidFigures: document.querySelectorAll('.mermaid-figure').length,
      katex: document.querySelectorAll('.katex').length,
      bodyChildren: document.body.children.length,
      bodyLen: document.body.innerText.length,
    };
  })()`);
}

// 040#5：在页面里动态 import 已构建的 mermaid（若可用），渲染多个语法错误块，
// 观察 document.body 是否出现容器外 error div、是否随重渲染累积。
async function stageMermaid(send) {
  const before = await evaluate(send, `(() => ({
    bodyChildren: document.body.children.length,
    syntaxErrorNodes: [...document.querySelectorAll('body *')].filter(e =>
      e.children.length === 0 && /Syntax error in text/i.test(e.textContent||'')).length,
    mermaidErrText: (document.body.innerText.match(/Syntax error in text/g)||[]).length,
  }))()`);

  // 用页面里已加载的 mermaid（040 实现是懒加载单例，全局挂在哪不确定）——
  // 先探测全局是否有可调用入口；没有就如实记录，不强造。
  const probe = await evaluate(send, `(async () => {
    const out = { globalMermaid: typeof window.mermaid, bodyChildTags: [...document.body.children].map(e => e.tagName+'.'+(e.className||'').toString().slice(0,30)) };
    // 尝试从现有 mermaid 图块附近的模块缓存不可得；仅报告现状
    return out;
  })()`);

  // 关键证据：统计当前页面所有游离在 .message-list 之外的可见文本节点里是否含 Syntax error
  const leakage = await evaluate(send, `(() => {
    const root = document.querySelector('[data-testid="message-list"]') || document.body;
    const allErr = [...document.querySelectorAll('body *')].filter(e => /Syntax error in text/i.test(e.textContent||''));
    const outside = allErr.filter(e => !root.contains(e));
    return {
      totalErrNodes: allErr.length,
      outsideMessageList: outside.length,
      outsideSamples: outside.slice(0,5).map(e => ({ tag: e.tagName, cls: (e.className||'').toString().slice(0,60), text: (e.textContent||'').slice(0,80) })),
    };
  })()`);

  return { before, probe, leakage };
}

// 047：JCEF 取图/剪贴板技术底。纯能力探测，不生成产品 UI。
async function stageCapture(send) {
  return evaluate(send, `(async () => {
    const out = {};
    // 1) 剪贴板 API 现状
    out.navigatorClipboard = !!navigator.clipboard;
    out.clipboardWrite = !!(navigator.clipboard && navigator.clipboard.write);
    out.clipboardWriteText = !!(navigator.clipboard && navigator.clipboard.writeText);
    out.ClipboardItem = typeof ClipboardItem;
    out.execCommand = typeof document.execCommand;
    // 2) canvas 取图链
    try {
      const c = document.createElement('canvas'); c.width = 8; c.height = 8;
      const ctx = c.getContext('2d'); ctx.fillStyle='#f00'; ctx.fillRect(0,0,8,8);
      out.canvas2d = true;
      out.toDataURL = c.toDataURL('image/png').slice(0,30);
      out.toBlob = await new Promise(r => { try { c.toBlob(b => r(b ? ('blob:'+b.type+':'+b.size) : null), 'image/png'); } catch(e) { r('ERR:'+e.message); } });
    } catch(e) { out.canvasError = e.message; }
    // 3) SVG -> Image -> canvas 是否可行（data URL 方式，不碰隐私）
    try {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>';
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      const img = new Image();
      out.svgToCanvas = await new Promise(r => {
        img.onload = () => {
          try { const c=document.createElement('canvas'); c.width=8;c.height=8; c.getContext('2d').drawImage(img,0,0); r('OK:'+c.toDataURL('image/png').slice(0,22)); }
          catch(e){ r('DRAW_ERR:'+e.message); }
        };
        img.onerror = () => r('IMG_ERR');
        img.src = url;
        setTimeout(()=>r('TIMEOUT'),3000);
      });
    } catch(e) { out.svgError = e.message; }
    // 4) KaTeX DOM 现状（是否渲染为 HTML+MathML）
    const k = document.querySelector('.katex');
    out.katexSample = k ? k.outerHTML.slice(0,160) : null;
    out.katexIsSvg = k ? !!k.querySelector('svg') : null;
    out.katexHasAnnotation = k ? !!k.querySelector('annotation') : null;
    return out;
  })()`);
}

// 填 prompt 并发送，等回复里出现 mermaid 块 + katex 落定
async function stageFeed(send) {
  const PROMPT = "请严格只输出下面两块 markdown，不要任何解释文字：\n\n```mermaid\ngraph TD\n  A[start] --> B( bad syntax >>>\n```\n\n行内公式 $x+y=z$ 和块级公式 $$\\sum_{i=1}^{3} i$$。";
  await evaluate(send, `(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    if (!ta) throw new Error("no composer");
    const proto = ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(ta, ${JSON.stringify(PROMPT)});
    else { ta.textContent = ${JSON.stringify(PROMPT)}; }
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return ta.value?.length ?? ta.textContent?.length ?? 0;
  })()`);
  await sleep(400);
  await evaluate(send, `document.querySelector('[data-testid="send-btn"]')?.click()`);
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const s = await evaluate(send, `(() => {
      const md = [...document.querySelectorAll('.markdown')].map(e => e.textContent || '');
      return {
        mermaidBlocks: document.querySelectorAll('code.language-mermaid, .mermaid-figure').length,
        katex: document.querySelectorAll('.katex').length,
        errText: (document.body.innerText.match(/Syntax error in text/g) || []).length,
        lastText: md.at(-1)?.slice(0, 120) || '',
        busy: !!document.querySelector('[data-testid="send-btn"][disabled]'),
      };
    })()`);
    if ((s.katex >= 1 && s.mermaidBlocks >= 1) || (!s.busy && s.lastText)) {
      return { settled: true, waitedMs: Date.now() - start, ...s };
    }
    await sleep(2500);
  }
  return { settled: false, waitedMs: 120000 };
}

// 039#6：裸 SVG（无围栏）应渲染为图形，围栏内同一源码应保持代码块文本。
// 内容锚定 fill=#3b82f6（探针独有颜色），不按 .at(-1) 取（用户可能并发对话）。
// FB_REUSE=1 时若页面已有带锚点的回复则直接断言（不重复发 prompt）。
function svgAssert() {
  return `(() => {
    const md = [...document.querySelectorAll('.markdown')];
    // 助手回复 = 含围栏代码块的命中（用户 prompt 里也有 Bare:/Fenced: 字样但无 pre）。
    const mine = md.find(e => /Fenced:/.test(e.textContent||'') && /Bare:/.test(e.textContent||'') && e.querySelector('pre'));
    if (!mine) return { found: false, busy: !!document.querySelector('[data-testid="send-btn"][disabled]') };
    const fenced = [...mine.querySelectorAll('pre code.language-svg')];
    return {
      found: true,
      busy: !!document.querySelector('[data-testid="send-btn"][disabled]'),
      bareRenderedSvg: mine.querySelectorAll('svg circle[fill="#3b82f6"]').length,
      circleInsidePre: [...mine.querySelectorAll('pre svg circle')].length,
      fencedBlocks: fenced.length,
      fencedHasSource: fenced.some(b => (b.textContent||'').includes('<circle cx="24"')),
      fencedIsInertText: fenced.every(b => !b.querySelector('svg')),
      scripts: mine.querySelectorAll('script').length,
      copyBtnOnFence: !!mine.querySelector('pre .code-copy-btn'),
    };
  })()`;
}
async function stageSvg(send) {
  const reuse = process.env.FB_REUSE === "1";
  if (reuse) {
    const first = await evaluate(send, svgAssert());
    if (first.found) {
      await sleep(3000);
      const second = await evaluate(send, svgAssert());
      return { reused: true, stable: JSON.stringify(first) === JSON.stringify(second), ...second };
    }
  }
  const PROMPT = '请严格只输出下面内容，不要任何解释文字。第一行输出 Bare:，下一行直接输出这段 SVG 源码（不要放进任何代码围栏）：\n<svg width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#3b82f6"></circle></svg>\n然后空一行输出 Fenced:，下一行开始把完全相同的 SVG 源码放进一个 ```svg 围栏代码块里。';
  await evaluate(send, `(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    if (!ta) throw new Error("no composer");
    const proto = ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return ta.value?.length ?? 0;
  })()`);
  await sleep(400);
  await evaluate(send, `document.querySelector('[data-testid="send-btn"]')?.click()`);
  const start = Date.now();
  let lastSig = "";
  let stableSince = 0;
  while (Date.now() - start < 180000) {
    const s = await evaluate(send, svgAssert());
    // 内容锚定 + 连续两次一致即认为落定（真机 busy 标志可能滞留，不作为判据）。
    const sig = JSON.stringify(s);
    if (s.found && s.fencedBlocks >= 1 && s.bareRenderedSvg >= 1 && sig === lastSig) {
      if (Date.now() - stableSince >= 4000) return { settled: true, waitedMs: Date.now() - start, ...s };
    } else {
      stableSince = Date.now();
    }
    lastSig = sig;
    await sleep(2500);
  }
  return { settled: false, waitedMs: 180000, last: lastSig };
}

(async () => {
  try {
    report.result = await withPage(async (send) => {
      switch (STAGE) {
        case "mermaid": return stageMermaid(send);
        case "capture": return stageCapture(send);
        case "feed": return stageFeed(send);
        case "svg": return stageSvg(send);
        case "state":
        default: return stageState(send);
      }
    });
    report.ok = true;
  } catch (e) {
    report.ok = false; report.error = String(e?.stack || e);
  }
  writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  dump(report, STAGE + " @ " + OUT);
  process.exit(report.ok ? 0 : 1);
})();
