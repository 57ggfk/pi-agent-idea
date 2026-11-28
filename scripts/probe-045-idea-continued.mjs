/**
 * 真机（真实 IDEA 2026.2 + CEF 144）续验：走查 probe-037 没覆盖的部分——
 * i18n 切语言、真实对话后的产出区、浅色主题、面板在窄工具窗里的观感。
 *
 * 用法：node scripts/probe-045-idea-continued.mjs [--cdp http://127.0.0.1:9222]
 */
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cdpArg = process.argv.indexOf("--cdp");
const CDP_HTTP = cdpArg > -1 ? process.argv[cdpArg + 1] : "http://127.0.0.1:9222";
const SHOT_DIR = join(process.cwd(), "build", "verify-screenshots");
mkdirSync(SHOT_DIR, { recursive: true });

const findings = [];
function note(where, what, severity, fix = "") {
  findings.push({ where, what, severity, fix });
  console.log(`[${severity}] ${where}: ${what}`);
}

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const pages = targets.filter((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1"));
const page = pages.at(-1);
if (!page) {
  console.error("no Pi Agent page target");
  process.exit(1);
}
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
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  return res.result?.value;
}
async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(res.data, "base64"));
  console.log(`  shot → ${name}.png`);
}
async function clickSelector(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(700);
  return true;
}
async function ensurePanelClosed() {
  const open = await evaluate(`(() => {
    const p = document.querySelector('[data-testid="status-panel"]');
    return !!(p && p.getBoundingClientRect().height > 0);
  })()`);
  if (open) {
    await clickSelector('[data-testid="status-panel-close"]');
    await sleep(400);
  }
}

// --- 1. the copy fix: no repeated word in the context row --------------------
await ensurePanelClosed();
await clickSelector('[data-testid="status-panel-btn"]');
await sleep(1000);
const ctxRow = await evaluate(`(() => {
  const r = document.querySelector('[data-testid="panel-run-ctx"]');
  if (!r) return null;
  return { key: r.querySelector('.panel-row-key')?.textContent ?? '', val: r.querySelector('.panel-row-val')?.textContent ?? '' };
})()`);
console.log("context row:", JSON.stringify(ctxRow));
if (ctxRow) {
  const label = ctxRow.key.trim();
  if (label && ctxRow.val.trim().startsWith(label)) {
    note("文案", `上下文行的值重复了标签词：「${label} | ${ctxRow.val}」`, "medium", "值只留数字（panel.run.contextValue）");
  } else {
    console.log("✓ 上下文行不再重复标签词");
  }
}
await shot("20-idea-context-row");

// --- 2. i18n: switch language and read the panel chrome ----------------------
const langInfo = await evaluate(`JSON.stringify([...document.querySelectorAll('button,[role=button],[data-testid]')]
  .map((e) => ({ tid: e.getAttribute('data-testid') || '', txt: (e.textContent || '').trim().slice(0, 30), title: e.getAttribute('title') || '', al: e.getAttribute('aria-label') || '' }))
  .filter((e) => /lang|语言|locale|中文|en/i.test(e.tid + ' ' + e.txt + ' ' + e.title + ' ' + e.al)).slice(0, 8))`);
console.log("language controls:", langInfo);
const langCandidates = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-testid]')]
  .map((e) => e.getAttribute('data-testid')).filter((t) => /lang|locale/i.test(t)))`);
console.log("language testids:", langCandidates);

// --- 3. the tool window is narrow: is the panel readable? --------------------
const layout = await evaluate(`(() => {
  const app = document.querySelector('.app') || document.body;
  const p = document.querySelector('[data-testid="status-panel"]');
  const r = p ? p.getBoundingClientRect() : null;
  return {
    appWidth: app.getBoundingClientRect().width,
    innerWidth: window.innerWidth,
    panel: r ? { left: r.left, right: r.right, width: r.width, top: r.top } : null,
    text: p ? p.innerText : '',
  };
})()`);
console.log("layout:", JSON.stringify(layout).slice(0, 700));
if (layout.panel && layout.panel.width > layout.appWidth - 8) {
  note("窄工具窗", `面板宽 ${layout.panel.width}px 几乎等于工具窗宽 ${layout.appWidth}px`, "low", "可接受，但值得观察");
}

// --- 4. every visible string, for a copy read-through ------------------------
const strings = await evaluate(`(() => {
  const p = document.querySelector('[data-testid="status-panel"]');
  if (!p) return [];
  return [...p.querySelectorAll('.panel-row-key, .panel-row-val, .panel-section-title, .panel-note, .panel-job-badge')]
    .map((e) => (e.textContent || '').trim()).filter(Boolean);
})()`);
console.log("panel strings:\n" + JSON.stringify(strings, null, 1));

console.log("\n=== findings ===");
for (const f of findings) console.log(`[${f.severity}] ${f.where}: ${f.what}${f.fix ? " → " + f.fix : ""}`);
writeFileSync(join(SHOT_DIR, "findings-idea.json"), JSON.stringify(findings, null, 2));
console.log(`\n${findings.length} findings`);
