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

// 041#9：让 pi 生成一个 SVG 文件，等消息里的「新增文件 diff 块 / 工具卡文件链接」
// 出现后点击它，验证 ide.openFile 被真实调用（宿主打开 IDE 编辑器标签）。
async function stage041File(send) {
  const PROMPT = '请在当前项目目录下创建文件 probe-0419-circle.svg，内容为一个 48×48 的 SVG 蓝色圆形（circle cx=24 cy=24 r=20 fill=#3b82f6）。只做这一件事，创建完成后用一句话确认即可。';
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
  let clicked = null;
  while (Date.now() - start < 180000) {
    const s = await evaluate(send, `(() => {
      const mds = [...document.querySelectorAll('.markdown')];
      const mine = mds.find(e => /probe-0419-circle\\.svg/.test(e.textContent||''));
      const toolLink = mine?.querySelector('.tool-file-link');
      const diffLink = [...(mine?.querySelectorAll('pre .file-link') ?? [])].find(e => /probe-0419-circle\\.svg/.test(e.dataset.path||''));
      return {
        found: !!mine,
        busy: !!document.querySelector('[data-testid="send-btn"][disabled]'),
        toolLinkText: toolLink?.textContent?.slice(0, 60) ?? null,
        diffLinkPath: diffLink?.dataset?.path ?? null,
        diffLinkCount: mine ? [...mine.querySelectorAll('pre .file-link')].length : 0,
      };
    })()`);
    if (s.found && s.diffLinkPath) {
      // 优先点 diff 块里的文件路径（041#9 修复的入口）
      await evaluate(send, `(() => {
        const mds = [...document.querySelectorAll('.markdown')];
        const mine = mds.find(e => /probe-0419-circle\\.svg/.test(e.textContent||''));
        const link = [...(mine?.querySelectorAll('pre .file-link') ?? [])].find(e => /probe-0419-circle\\.svg/.test(e.dataset.path||''));
        link?.click();
        return link?.dataset.path ?? null;
      })()`);
      clicked = { entry: "diff-block", path: s.diffLinkPath };
      break;
    }
    if (s.found && s.toolLinkText && !s.busy) {
      // 没有文本 diff 块时点工具卡头部的文件链接
      await evaluate(send, `(() => {
        const mds = [...document.querySelectorAll('.markdown')];
        const mine = mds.find(e => /probe-0419-circle\\.svg/.test(e.textContent||''));
        mine?.querySelector('.tool-file-link')?.click();
        return true;
      })()`);
      clicked = { entry: "tool-card", path: s.toolLinkText };
      break;
    }
    await sleep(2500);
  }
  await sleep(2000);
  const after = await evaluate(send, `(() => ({
    fileLinks: [...document.querySelectorAll('.markdown pre .file-link')].map(e => e.dataset.path),
    toolFileLinks: [...document.querySelectorAll('.tool-file-link')].map(e => e.textContent.slice(0, 60)),
  }))()`);
  return { clicked, waitedMs: Date.now() - start, after };
}

// 044 真机效果验证（反馈批修订：#4 自动转存 / #1#3 hover 浮层 / #2b 折回）。
// 全程只动 composer，不发送消息。CDP Input.dispatchMouseEvent 走真实鼠标路径。
async function cdpMouse(send, x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function stage044(send) {
  const out = {};
  const setComposer = () => evaluate(send, `(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, "");
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const paste = (text) => evaluate(send, `(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(text)});
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  const dom = () => evaluate(send, `(() => ({
    value: (document.querySelector('[data-testid="composer-input"]')?.value ?? ''),
    chips: [...document.querySelectorAll('[data-testid="paste-chip"]')].map(e => e.textContent),
    refs: document.querySelectorAll('[data-testid="ref-token"]').length,
    preview: !!document.querySelector('[data-testid="paste-preview"]'),
    saveFailed: !!document.querySelector('[data-testid="paste-save-failed"]'),
    collapse: !!document.querySelector('[data-testid="paste-collapse"]'),
  }))()`);

  // ---- A: >2000 行自动转存
  await setComposer();
  const huge = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
  await paste(huge);
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const s = await dom();
    if (s.refs >= 1 || s.saveFailed) { out.autoSave = { refs: s.refs, saveFailed: s.saveFailed, value: s.value.slice(0, 80) }; break; }
  }
  if (!out.autoSave) out.autoSave = { timeout: true, ...(await dom()) };

  // ---- B: hover 浮层跨缝 + 「存为文件」真实鼠标路径
  await setComposer();
  const big = Array.from({ length: 40 }, (_, i) => `## line ${i}`).join("\n");
  await paste(big);
  await sleep(500);
  const chipBox = await evaluate(send, `(() => {
    const chip = document.querySelector('[data-testid="paste-chip"]');
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);
  out.chipBox = chipBox;
  if (chipBox) {
    // 移入 chip → 浮层出现
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: chipBox.x, y: chipBox.y });
    await sleep(400);
    const previewBox = await evaluate(send, `(() => {
      const pv = document.querySelector('[data-testid="paste-preview"]');
      if (!pv) return null;
      const r = pv.getBoundingClientRect();
      return { x: r.x + r.width / 2, top: r.y, bottom: r.y + r.height, h: r.height };
    })()`);
    out.previewAppeared = !!previewBox;
    if (previewBox) {
      // 沿真实路径跨进浮层内部——缝隙即关的场景
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: previewBox.x, y: previewBox.bottom - previewBox.h / 2 });
      await sleep(400);
      const still1 = await evaluate(send, `!!document.querySelector('[data-testid="paste-preview"]')`);
      out.previewSurvivesTrip = still1;
      // 找「存为文件」按钮并真实点击
      const btn = await evaluate(send, `(() => {
        const b = document.querySelector('[data-testid="paste-preview-save"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      out.saveBtn = btn;
      if (btn) {
        await cdpMouse(send, btn.x, btn.y);
        await sleep(800);
        const s = await dom();
        out.hoverSave = { refs: s.refs, previewAfterSave: s.preview };
      }
    }
  }

  // ---- C: Esc 关闭浮层 + 草稿不动
  await setComposer();
  await paste(big);
  await sleep(400);
  const chip2 = await evaluate(send, `(() => {
    const chip = document.querySelector('[data-testid="paste-chip"]');
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (chip2) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: chip2.x, y: chip2.y });
    await sleep(400);
    out.escPreviewOpen = await evaluate(send, `!!document.querySelector('[data-testid="paste-preview"]')`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(300);
    out.escResult = await evaluate(send, `(() => ({
      preview: !!document.querySelector('[data-testid="paste-preview"]'),
      value: (document.querySelector('[data-testid="composer-input"]')?.value ?? ''),
    }))()`);
  }

  // ---- D: #2b 展开编辑折回
  await setComposer();
  await paste(big);
  await sleep(400);
  const chip3 = await evaluate(send, `(() => {
    const chip = document.querySelector('[data-testid="paste-chip"]');
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (chip3) {
    await cdpMouse(send, chip3.x, chip3.y);
    await sleep(400);
    await evaluate(send, `(() => {
      const ta = document.querySelector('[data-testid="composer-input"]');
      ta.focus();
      ta.setSelectionRange(0, 0);
      return true;
    })()`);
    await send("Input.insertText", { text: "edited " });
    await sleep(400);
    out.afterEdit = await dom();
    const collapseBtn = await evaluate(send, `(() => {
      const b = document.querySelector('[data-testid="paste-collapse"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    out.collapseVisibleAfterEdit = !!collapseBtn;
    if (collapseBtn) {
      await cdpMouse(send, collapseBtn.x, collapseBtn.y);
      await sleep(400);
      const s = await dom();
      out.afterFold = { chips: s.chips, value: s.value.slice(0, 60) };
      // 再展开：内容应是编辑后文本
      const chip4 = await evaluate(send, `(() => {
        const chip = document.querySelector('[data-testid="paste-chip"]');
        if (!chip) return null;
        const r = chip.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (chip4) {
        await cdpMouse(send, chip4.x, chip4.y);
        await sleep(400);
        out.reExpand = await evaluate(send, `(() => (document.querySelector('[data-testid="composer-input"]')?.value ?? '').slice(0, 40))()`);
      }
    }
  }
  await setComposer();
  return out;
}

// 045 真机效果验证：统一收尾规则。A 折叠 chip 后收尾+光标；B 消息引用（quote）
// 单行两空格；C 文件引用 token 两空格。B 需要一条真实消息，其余不发送。
async function stage045(send) {
  const out = {};
  const setComposer = () => evaluate(send, `(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, "");
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const state = () => evaluate(send, `(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    return { value: ta?.value ?? "", caret: ta ? [ta.selectionStart, ta.selectionEnd] : null };
  })()`);
  const pasteText = (text) => evaluate(send, `(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(text)});
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);

  // ---- A: 多行粘贴折叠 → chip + \n，光标落新行
  await setComposer();
  await pasteText(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
  await sleep(800);
  out.foldMulti = await state();

  // ---- A2: 单行超长粘贴折叠 → chip + 两空格
  await setComposer();
  await pasteText("x".repeat(900));
  await sleep(800);
  out.foldSingle = await state();
  await setComposer();

  // ---- B: 发一条真实短消息，落定后点用户消息的「引用」，断言 "> ...  " 两空格
  await setComposer();
  await evaluate(send, `(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, "quote probe 045");
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-testid="send-btn"]')?.click();
    return true;
  })()`);
  let settledB = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const dot = await evaluate(send, `document.querySelector('[data-testid="status-dot"]')?.className ?? ''`);
    if (i > 2 && !/busy/.test(dot)) { settledB = true; break; }
  }
  out.settledB = settledB;
  if (settledB) {
    await evaluate(send, `(() => {
      const item = document.querySelector('[data-testid="item-user"]');
      const r = item?.getBoundingClientRect();
      if (!r) return null;
      return { x: r.x + Math.min(r.width / 2, 120), y: r.y + r.height / 2 };
    })()`).then((pos) => {
      if (!pos) return Promise.resolve();
      return send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
    });
    await sleep(400);
    const qb = await evaluate(send, `(() => {
      const item = document.querySelector('[data-testid="item-user"]');
      const b = item?.querySelector('[data-testid="act-quote"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    out.quoteBtn = qb;
    if (qb) {
      await cdpMouse(send, qb.x, qb.y);
      await sleep(600);
      out.quoteTrailing = await state();
    }
  }

  // ---- C: 文件引用（页面内 DragEvent drop 走 insertRefTokens）→ 两空格
  await evaluate(send, `(() => {
    const composer = document.querySelector('[data-testid="composer"]');
    const dt = new DataTransfer();
    dt.items.add(new File([], 'src', { type: '' }));
    composer.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(600);
  out.refDrop = await state();
  await setComposer();
  return out;
}

(async () => {
  try {
    report.result = await withPage(async (send) => {
      switch (STAGE) {
        case "mermaid": return stageMermaid(send);
        case "capture": return stageCapture(send);
        case "feed": return stageFeed(send);
        case "svg": return stageSvg(send);
        case "041file": return stage041File(send);
        case "044": return stage044(send);
        case "045": return stage045(send);
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
