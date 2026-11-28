/**
 * 状态面板真机走查（普通用户视角）。
 *
 * 走真实沙箱 IDE（runIde + mock pi），用裸 CDP 驱动页面：找入口 → 开面板 →
 * 逐分区核对 → 窄视口 → 明暗主题 → 反复开关。每步截图到 build/verify-screenshots/。
 *
 * 前置：
 *   PI_IDE_E2E=<mock-pi.mjs> PI_IDE_E2E_PROJECT=<project> ./gradlew runIde
 *
 * 用法：node scripts/probe-037-status-panel.mjs [--cdp http://127.0.0.1:9222]
 */
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cdpArg = process.argv.indexOf("--cdp");
const CDP_HTTP = cdpArg > -1 ? process.argv[cdpArg + 1] : "http://127.0.0.1:9222";
const scenarioArg = process.argv.indexOf("--scenario");
const SCENARIO = scenarioArg > -1 ? process.argv[scenarioArg + 1] : "";
const SHOT_DIR = join(process.cwd(), "build", "verify-screenshots");
mkdirSync(SHOT_DIR, { recursive: true });

const findings = [];
function note(where, what, severity, fix = "") {
  findings.push({ where, what, severity, fix });
  console.log(`[${severity}] ${where}: ${what}`);
}
function fail(message) {
  console.error(`PROBE-037 FAIL: ${message}`);
  process.exit(1);
}

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const pages = targets.filter((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1"));
const page = pages.at(-1);
if (!page) fail("Pi Agent page target not found");
console.log(`attached to ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("ws error"));
});
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return res.result?.value;
}

// The fixtures that populate the jobs/checklist sections only exist in the
// scripted scenarios (?panel=1 / ?panel=todo). Reload into the requested
// scenario before walking anything, so each run starts from a known URL.
if (SCENARIO) {
  const url = new URL(page.url);
  url.searchParams.set("panel", SCENARIO);
  console.log(`reloading into scenario ?panel=${SCENARIO}`);
  await send("Page.navigate", { url: url.toString() });
  await sleep(5000);
}

async function waitFor(expression, timeoutMs = 20_000, everyMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return true;
    await sleep(everyMs);
  }
  return false;
}
async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  const file = join(SHOT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(res.data, "base64"));
  console.log(`  shot → ${file}`);
  return file;
}

/**
 * Clicks through real pointer input. el.click() does NOT reach React's
 * synthetic handlers in this JCEF build — the button only reacts to a
 * dispatched mousePressed/mouseReleased pair at its coordinates.
 */
async function clickSelector(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(500);
  return true;
}

/**
 * The status button is a toggle: clicking it while the panel is open CLOSES
 * it. Every walkthrough step therefore starts from a known-closed panel, so a
 * stray open state from a previous step cannot flip the assertion.
 */
async function ensurePanelClosed() {
  const open = await evaluate(`(() => {
    const p = document.querySelector('[data-testid="status-panel"]');
    return !!(p && p.getBoundingClientRect().height > 0);
  })()`);
  if (open) {
    await clickSelector('[data-testid="status-panel-close"]');
    await sleep(300);
    // The close button lives inside the panel; if it did not take, fall back
    // to toggling the entry button.
    const stillOpen = await evaluate(`(() => {
      const p = document.querySelector('[data-testid="status-panel"]');
      return !!(p && p.getBoundingClientRect().height > 0);
    })()`);
    if (stillOpen) {
      await clickSelector('[data-testid="status-panel-btn"]');
      await sleep(300);
    }
  }
  return await evaluate(`(() => {
    const p = document.querySelector('[data-testid="status-panel"]');
    return !(p && p.getBoundingClientRect().height > 0);
  })()`);
}

// The UI boots with an empty state; drive it to a populated one.
await waitFor('document.querySelector(\'[data-testid="empty-state"]\')', 40_000);
await waitFor('document.querySelector(\'[data-testid="composer-input"]\')', 15_000);
console.log("✓ UI booted");

// The scripted fixtures (?panel=1 / ?panel=todo) only fire as part of a run,
// so an ordinary user would type something and send it. Do the same.
if (SCENARIO) {
  const typed = await evaluate(`(() => {
    const el = document.querySelector('[data-testid="composer-input"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, 'walk through the status panel');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (typed) {
    await sleep(400);
    await clickSelector('[data-testid="send-btn"]');
    console.log("✓ sent a prompt to trigger the scripted fixtures");
    await sleep(6000);
  }
}

// --- A. entry discoverability -------------------------------------------------
// A1: is there a status button on the chat tab bar at all?
const btnInfo = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('button,[role=button]')];
  const hit = btns.map((b) => ({
    text: (b.textContent || '').trim(),
    testid: b.getAttribute('data-testid') || '',
    title: b.getAttribute('title') || b.getAttribute('aria-label') || '',
    cls: (b.className || '').toString(),
  })).filter((b) => /status|状态/i.test(b.text + ' ' + b.title + ' ' + b.testid));
  return { count: hit.length, hit: hit.slice(0, 8) };
})()`);
console.log("entry candidates:", JSON.stringify(btnInfo));
if (!btnInfo.count) {
  note("入口", "聊天 tab 栏上找不到「状态」按钮——普通用户根本发现不了这个功能", "high", "给按钮加图标+悬停提示（title/aria-label）");
}
await shot("01-chat-tab-bar");

// A2: the button must carry no badge (FR-001).
const badge = await evaluate(`(() => {
  const btns = [...document.querySelectorAll('button,[role=button]')];
  const b = btns.find((x) => /status|状态/i.test((x.textContent||'') + ' ' + (x.getAttribute('title')||'') + ' ' + (x.getAttribute('aria-label')||'')));
  if (!b) return { found: false };
  const kids = [...b.children].filter((c) => {
    const t = (c.textContent || '').trim();
    return /\\d/.test(t) && t.length <= 3;
  });
  return { found: true, badgeChildren: kids.map((c) => c.textContent.trim()) };
})()`);
console.log("badge check:", JSON.stringify(badge));
if (badge.found && badge.badgeChildren.length) {
  note("入口", `状态按钮上出现了数字角标（${badge.badgeChildren.join(",")}）——用户拍板不做角标`, "high", "去掉角标");
}

// --- B. open the panel --------------------------------------------------------
await ensurePanelClosed();
const opened = await clickSelector('[data-testid="status-panel-btn"]');
if (!opened) fail("cannot click the status button");
await sleep(800);

const panelState = await evaluate(`(() => {
  const panel = document.querySelector('[data-testid="status-panel"]');
  if (!panel) return { found: false };
  const r = panel.getBoundingClientRect();
  return {
    found: true,
    rect: { top: r.top, right: window.innerWidth - r.right, width: r.width, height: r.height },
    innerWidth: window.innerWidth,
    text: panel.innerText.slice(0, 2000),
    headings: [...panel.querySelectorAll('h3,h4,[data-testid^=section-title],.status-section-title')].map((h) => (h.textContent||'').trim()),
    testids: [...panel.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')).slice(0, 60),
  };
})()`);
console.log("panel:", JSON.stringify(panelState).slice(0, 3000));
if (!panelState.found) fail("status panel did not open");
await shot("02-panel-open");

// B2: geometry — the outline anchor (top 40 / right 8) and the 320px cap.
const geo = panelState.rect;
if (Math.abs(geo.top - 40) > 6) {
  note("几何", `弹层 top=${geo.top.toFixed(0)}px，规格锚点是 40px`, "medium", "对齐 outline 弹层的锚点");
}
if (Math.abs(geo.right - 8) > 6) {
  note("几何", `弹层 right=${geo.right.toFixed(0)}px，规格锚点是 8px`, "medium", "对齐 outline 弹层的锚点");
}
if (geo.width > 320.5) {
  note("几何", `弹层宽 ${geo.width.toFixed(0)}px，超过 320px 上限`, "medium", "width: min(320px, 100cqw - 24px)");
}

// B3: the five sections.
// In the default scenario the panel legitimately shows only 运行状态 + 产出 —
// FR-011/FR-012 hide the jobs/checklist sections when there is no data (a
// hidden section, not an empty shell). The scripted scenario is the one that
// must show every populated section.
const wanted = ["运行状态", "后台任务", "处理清单", "待处理", "产出"];
const body = panelState.text || "";
const present = wanted.filter((w) => body.includes(w));
const missing = wanted.filter((w) => !body.includes(w));
console.log("sections present:", JSON.stringify(present), "missing:", JSON.stringify(missing));
if (SCENARIO) {
  // Populated scenario: every section that carries data must be visible.
  if (missing.includes("后台任务") || missing.includes("处理清单")) {
    note("分区", `场景 ?panel=${SCENARIO} 下缺少分区：${missing.join("、")}`, "high", "夹具数据没有落到对应分区");
  }
} else {
  // Default scenario: the two data-driven sections stay hidden by design.
  for (const m of missing) {
    if (m === "后台任务" || m === "处理清单" || m === "待处理") {
      console.log(`  (default scenario: 「${m}」隐藏是 spec 行为 FR-011/FR-012，不算缺陷)`);
    } else {
      note("分区", `面板里没有「${m}」分区`, "medium", `补 ${m} 分区`);
    }
  }
}
await shot("03-panel-sections");

// --- C. mutual exclusion with outline / search -------------------------------
const excl = await evaluate(`(() => {
  const panel = document.querySelector('[data-testid="status-panel"]');
  const others = ['[data-testid="outline-panel"]','[data-testid="search-panel"]','[data-testid="outline-popover"]','[data-testid="search-popover"]'];
  const visibleOthers = others.filter((sel) => { const e = document.querySelector(sel); return e && e.getBoundingClientRect().height > 0; });
  return { panelVisible: !!panel && panel.getBoundingClientRect().height > 0, visibleOthers };
})()`);
console.log("exclusion:", JSON.stringify(excl));
if (excl.visibleOthers.length) {
  note("互斥", `打开状态面板时 ${excl.visibleOthers.join(",")} 仍然可见——同屏两个弹层`, "high", "复用既有弹层互斥逻辑");
}

// --- D. i18n: switch to Chinese and see the chrome relabel --------------------
const i18n = await clickSelector('[data-testid="lang-btn"], [data-testid="language-btn"]');
if (i18n) {
  await sleep(900);
  const after = await evaluate(`(() => {
    const p = document.querySelector('[data-testid="status-panel"]');
    return p ? p.innerText.slice(0, 600) : '';
  })()`);
  console.log("after lang click:", JSON.stringify(after).slice(0, 900));
  await shot("04-after-lang-toggle");
} else {
  console.log("no language toggle button found — checking i18n another way");
}

// --- E. narrow viewport (360px) ----------------------------------------------
await send("Emulation.setDeviceMetricsOverride", {
  width: 360, height: 740, deviceScaleFactor: 1, mobile: false,
});
await sleep(1200);
const narrow = await evaluate(`(() => {
  const panel = document.querySelector('[data-testid="status-panel"]');
  if (!panel) return { found: false };
  const r = panel.getBoundingClientRect();
  const de = document.documentElement;
  return {
    found: true,
    rect: { left: r.left, right: r.right, width: r.width },
    scrollW: de.scrollWidth, clientW: de.clientWidth,
    bodyScrollW: document.body.scrollWidth,
  };
})()`);
console.log("narrow:", JSON.stringify(narrow));
if (narrow.found) {
  if (narrow.scrollW > narrow.clientW + 1) {
    note("窄视口", `360px 视口下出现横向滚动（scrollWidth=${narrow.scrollW} > clientWidth=${narrow.clientW}）`, "high", "面板宽度用 min(320px, 100cqw - 24px)，避免溢出");
  }
  if (narrow.rect.left < -1) {
    note("窄视口", `面板左边缘跑到视口外（left=${narrow.rect.left.toFixed(0)}）`, "high", "窄视口下右对齐不得越界");
  }
}
await shot("05-narrow-360");
await send("Emulation.clearDeviceMetricsOverride");
await sleep(600);

// --- F. open/close stability --------------------------------------------------
for (let i = 0; i < 6; i++) {
  await ensurePanelClosed();
  await clickSelector('[data-testid="status-panel-btn"]');
  await sleep(150);
}
await sleep(700);
const afterChurn = await evaluate(`(() => {
  const p = document.querySelector('[data-testid="status-panel"]');
  return { present: !!p, visible: !!p && p.getBoundingClientRect().height > 0 };
})()`);
console.log("churn:", JSON.stringify(afterChurn));
if (!afterChurn.present) {
  note("稳定性", "连续开关 6 次后面板节点消失——面板没有正常挂载/卸载", "medium", "检查条件渲染与 key");
}

// --- G. content sanity: what does an ordinary user actually see? --------------
await ensurePanelClosed();
await clickSelector('[data-testid="status-panel-btn"]');
await sleep(600);
const content = await evaluate(`(() => {
  const p = document.querySelector('[data-testid="status-panel"]');
  if (!p) return { found: false };
  const sections = [...p.querySelectorAll('.panel-section')].map((s) => ({
    title: (s.querySelector('.panel-section-title')?.textContent || '').trim(),
    testid: s.getAttribute('data-testid'),
    rows: s.querySelectorAll('.panel-row,.check-item,.job-row,.output-row').length,
    text: s.innerText.replace(/\\n+/g, ' | ').slice(0, 200),
  }));
  return { found: true, sections, fullText: p.innerText };
})()`);
console.log("sections:", JSON.stringify(content.sections, null, 1).slice(0, 2500));
if (content.found) {
  const emptyTitles = content.sections.filter((s) => s.rows === 0).map((s) => s.title || s.testid);
  console.log("sections with no rows:", JSON.stringify(emptyTitles));
}
await shot("06-panel-content");

console.log("\n=== findings ===");
for (const f of findings) console.log(`[${f.severity}] ${f.where}: ${f.what}${f.fix ? " → " + f.fix : ""}`);
writeFileSync(join(SHOT_DIR, "findings.json"), JSON.stringify(findings, null, 2));
console.log(`\n${findings.length} findings; screenshots in ${SHOT_DIR}`);
