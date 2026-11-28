/**
 * 状态面板真机验收（真实 pi）：验证 FR-011 后台任务分区与 FR-006 产出区在
 * 真实事件流下的表现。
 *
 * 与 probe-037（mock pi）互补：本脚本连真实 pi，让 pi-subagents 发真实的
 * setWidget(subagent-async) 快照，并让 pi 真的写一个文件。
 *
 * 前置：PI_IDE_E2E=real PI_IDE_E2E_PROJECT=<project> ./gradlew runIde
 * 用法：node scripts/probe-038-status-panel-real.mjs [--cdp http://127.0.0.1:9222]
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
  console.error("PROBE-038 FAIL: Pi Agent page target not found");
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
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  }
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
  await sleep(600);
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
async function panelSnapshot() {
  return evaluate(`(() => {
    const p = document.querySelector('[data-testid="status-panel"]');
    if (!p) return { found: false };
    return {
      found: true,
      text: p.innerText,
      testids: [...p.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')),
      jobs: [...p.querySelectorAll('[data-testid="panel-job"]')].map((j) => j.innerText.replace(/\\n+/g, ' | ')),
      outputs: [...p.querySelectorAll('[data-testid="panel-output-item"]')].map((o) => o.innerText.replace(/\\n+/g, ' | ')),
      checklist: [...p.querySelectorAll('[data-testid^="panel-check"]')].map((c) => c.innerText.replace(/\\n+/g, ' | ')),
    };
  })()`);
}

// --- 1. is real pi up? -------------------------------------------------------
await sleep(6000);
const version = await evaluate(`document.querySelector('[data-testid="status-version"]')?.textContent ?? ''`);
console.log("pi version on screen:", version);
if (!version || version.includes("mock")) {
  console.error("PROBE-038 FAIL: not a real pi session");
  process.exit(1);
}

// Capture every bridge poll payload so the raw setWidget(subagent-async)
// snapshots are on disk as evidence (the panel is a view over them).
await evaluate(`(() => {
  window.__all = [];
  if (!window.__origJson) window.__origJson = Response.prototype.json;
  Response.prototype.json = async function (...a) {
    const out = await window.__origJson.apply(this, a);
    try { window.__all.push(JSON.stringify(out)); } catch (e) {}
    return out;
  };
  return 'patched';
})()`);
console.log("✓ capturing bridge poll payloads");

// --- 2. the extension registration frame ------------------------------------
// pi-subagents registers itself with an empty setWidget(subagent-async) frame
// at session start. If the panel shows the jobs section in its "installed but
// empty" state, FR-011's channel A is wired end to end.
await ensurePanelClosed();
await clickSelector('[data-testid="status-panel-btn"]');
await sleep(1200);
let snap = await panelSnapshot();
console.log("panel testids:", JSON.stringify(snap.testids));
console.log("panel text:\n" + (snap.text ?? "").slice(0, 1200));
await shot("10-real-panel-initial");

const hasJobsSection = (snap.testids ?? []).includes("panel-jobs");
if (!hasJobsSection) {
  note(
    "后台任务",
    "真实 pi 启动后「后台任务」分区没有出现——pi-subagents 的 setWidget(subagent-async) 注册帧没有落到面板",
    "high",
    "查 store 的 extension_ui_request 分发与 SUBAGENT_ASYNC_WIDGET_KEY 匹配",
  );
} else {
  console.log("✓ 后台任务分区已出现（注册帧到达）");
  if ((snap.testids ?? []).includes("panel-jobs-empty")) {
    console.log("✓ 显示「已安装但暂无作业」空态");
  }
}

// --- 3. run a real prompt that writes a file --------------------------------
// A plain user prompt: "write a file". The output section must list it.
await ensurePanelClosed();
const typed = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="composer-input"]');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, 'Create a file named hello-panel.txt containing the text hello panel');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
if (!typed) {
  note("产出", "找不到输入框", "high", "");
} else {
  await sleep(500);
  await clickSelector('[data-testid="send-btn"]');
  console.log("✓ prompt sent; waiting for the reply…");
  // The reply streams; give pi room to write the file.
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const streaming = await evaluate(`document.querySelector('[data-testid="status-dot"]')?.className ?? ''`);
    if (!/running|streaming|pulse/i.test(streaming)) break;
  }
  await sleep(2000);
  await ensurePanelClosed();
  await clickSelector('[data-testid="status-panel-btn"]');
  await sleep(1200);
  snap = await panelSnapshot();
  console.log("panel testids after the run:", JSON.stringify(snap.testids));
  console.log("outputs:", JSON.stringify(snap.outputs));
  console.log("jobs:", JSON.stringify(snap.jobs));
  console.log("checklist:", JSON.stringify(snap.checklist));
  console.log("panel text:\n" + (snap.text ?? "").slice(0, 1500));
  await shot("11-real-panel-after-run");

  if ((snap.outputs ?? []).length === 0) {
    note("产出", "pi 写了文件但「产出」区是空的——FR-006 的工具调用推导没有生效", "high", "查 transcript 里 write/edit 工具调用的形状与解析");
  } else {
    console.log("✓ 产出区列出了 " + snap.outputs.length + " 个文件");
  }
}

// --- 4. a real background job → the jobs section must fill in ---------------
// This is FR-011's core: pi-subagents announces background work through
// setWidget(widgetKey:"subagent-async") snapshots, and the panel renders one
// row per job (name, four-state badge, step progress, chain flow).
const JOB_PROMPT =
  "Start a background subagent (async: true) that writes notes/subagent-check.txt " +
  "containing the text subagent ran. Report the run id as soon as it is started.";
await ensurePanelClosed();
const jobTyped = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="composer-input"]');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(JOB_PROMPT)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
if (jobTyped) {
  await sleep(500);
  await clickSelector('[data-testid="send-btn"]');
  console.log("✓ asked pi for a background job; polling the panel…");
  let jobSeen = false;
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    await ensurePanelClosed();
    await clickSelector('[data-testid="status-panel-btn"]');
    await sleep(800);
    snap = await panelSnapshot();
    const n = (snap.jobs ?? []).length;
    console.log(`  poll ${i + 1}: jobs=${n}`);
    if (n > 0) {
      console.log("✓ 后台任务行出现：", JSON.stringify(snap.jobs, null, 1));
      console.log("panel text:\n" + (snap.text ?? "").slice(0, 1000));
      await shot("12-real-panel-bg-job");
      jobSeen = true;
      break;
    }
  }
  if (!jobSeen) {
    note(
      "后台任务",
      "真实后台作业启动了，但面板没有出现作业行——setWidget(subagent-async) 的带作业快照没有落到面板",
      "high",
      "查 store 的 noteSubagentAsyncWidget 解析与 250ms 节流",
    );
  }
}

// --- 5. the raw frames behind the view --------------------------------------
const raw = JSON.parse(await evaluate("JSON.stringify(window.__all)"));
const widgetFrames = [];
for (const batch of raw) {
  if (!batch.includes("setWidget")) continue;
  let obj;
  try { obj = JSON.parse(batch); } catch { continue; }
  for (const entry of obj.events ?? []) {
    const d = entry.record?.data;
    if (d?.method === "setWidget") {
      widgetFrames.push({
        widgetKey: d.widgetKey,
        lines: Array.isArray(d.widgetLines) ? d.widgetLines.map((l) => String(l).slice(0, 1500)) : d.widgetLines,
      });
    }
  }
}
console.log(`\nbridge payloads captured: ${raw.length}; setWidget frames: ${widgetFrames.length}`);
console.log("widget keys:", JSON.stringify([...new Set(widgetFrames.map((f) => f.widgetKey))]));
writeFileSync(join(SHOT_DIR, "real-widget-frames.json"), JSON.stringify(widgetFrames, null, 2));

console.log("\n=== findings ===");
for (const f of findings) console.log(`[${f.severity}] ${f.where}: ${f.what}${f.fix ? " → " + f.fix : ""}`);
writeFileSync(join(SHOT_DIR, "findings-real.json"), JSON.stringify(findings, null, 2));
console.log(`\n${findings.length} findings`);

