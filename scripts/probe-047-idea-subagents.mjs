/**
 * 真机：换到本机 magpie provider（127.0.0.1:3425），再触发一次后台 subagent，
 * 验证「子代理」分区（FR-013）与「后台任务」分区（FR-011）在真实事件流下的表现。
 *
 * 用法：node scripts/probe-047-idea-subagents.mjs [--cdp http://127.0.0.1:9222]
 */
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cdpArg = process.argv.indexOf("--cdp");
const CDP_HTTP = cdpArg > -1 ? process.argv[cdpArg + 1] : "http://127.0.0.1:9222";
const SHOT_DIR = join(process.cwd(), "build", "verify-screenshots");
mkdirSync(SHOT_DIR, { recursive: true });

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

// --- 1. switch the model to the local magpie provider -----------------------
const chip = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="model-chip"]');
  if (!el) return null;
  return { text: (el.textContent || '').trim().slice(0, 60), title: el.getAttribute('title') || '' };
})()`);
console.log("model chip:", JSON.stringify(chip));
await clickSelector('[data-testid="model-chip"]');
await sleep(1200);
const picker = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-testid], button, [role=option], [role=menuitem]')]
  .map((e) => ({ tid: e.getAttribute('data-testid') || '', txt: (e.textContent || '').trim().slice(0, 50) }))
  .filter((e) => /magpie|deepseek|provider/i.test(e.txt) || /model|provider/i.test(e.tid)).slice(0, 12))`);
console.log("picker entries:", picker);
const picked = await evaluate(`(() => {
  const el = [...document.querySelectorAll('[data-testid], button, [role=option], [role=menuitem]')]
    .find((e) => /magpie/i.test((e.textContent || '')) || /magpie/i.test(e.getAttribute('data-testid') || ''));
  if (!el) return null;
  el.click();
  return (el.textContent || '').trim().slice(0, 60);
})()`);
console.log("picked:", picked);
await sleep(2500);
const chipAfter = await evaluate(`document.querySelector('[data-testid="model-chip"]')?.textContent ?? ''`);
console.log("model chip now:", chipAfter);

// --- 2. tap the poll payloads and ask for a background subagent -------------
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

const PROMPT =
  "Start a background subagent (async: true) that writes notes/agent-check.txt containing " +
  "the text agent ran. Report the run id as soon as it is started; do not wait for it to finish.";
await evaluate(`(() => {
  const el = document.querySelector('[data-testid="composer-input"]');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(PROMPT)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(700);
await clickSelector('[data-testid="send-btn"]');
console.log("✓ prompt sent");

// --- 3. watch the panel for the sub-agent section ---------------------------
const PANEL = `(() => {
  const p = document.querySelector('[data-testid="status-panel"]');
  if (!p) return { open: false };
  return {
    open: true,
    subagents: [...p.querySelectorAll('[data-testid="panel-subagent"]')].map((e) => ({
      text: e.innerText.replace(/\\n+/g, ' | '),
      badge: e.querySelector('[data-testid="panel-subagent-badge"]')?.textContent ?? '',
    })),
    subagentSection: !!p.querySelector('[data-testid="panel-subagents"]'),
    jobs: [...p.querySelectorAll('[data-testid="panel-job"]')].map((j) => j.innerText.replace(/\\n+/g, ' | ')),
    jobsEmpty: !!p.querySelector('[data-testid="panel-jobs-empty"]'),
    text: p.innerText,
  };
})()`;

for (let i = 0; i < 30; i++) {
  await sleep(6000);
  await clickSelector('[data-testid="status-panel-btn"]');
  await sleep(900);
  const state = await evaluate(PANEL);
  const n = (state.subagents ?? []).length;
  console.log(`  poll ${i + 1}: subagents=${n} section=${state.subagentSection} jobs=${(state.jobs ?? []).length}`);
  if (n > 0) {
    console.log("✓ 子代理分区出现：", JSON.stringify(state.subagents, null, 1));
    console.log("panel text:\n" + (state.text ?? "").slice(0, 1200));
    await shot("30-idea-subagents-section");
    break;
  }
  if (i === 14) {
    await shot("30-idea-subagents-mid");
    console.log("mid panel text:\n" + (state.text ?? "").slice(0, 900));
  }
}

// --- 4. what did the wire actually carry? -----------------------------------
const raw = JSON.parse(await evaluate("JSON.stringify(window.__all)"));
const methods = {};
const widgetKeys = {};
let notifyRows = 0;
let toolResults = 0;
for (const batch of raw) {
  let obj;
  try { obj = JSON.parse(batch); } catch { continue; }
  for (const entry of obj.events ?? []) {
    const d = entry.record?.data;
    if (!d || typeof d !== "object") continue;
    if (d.type === "extension_ui_request") {
      methods[d.method] = (methods[d.method] ?? 0) + 1;
      if (d.method === "setWidget") widgetKeys[d.widgetKey ?? "(none)"] = (widgetKeys[d.widgetKey ?? "(none)"] ?? 0) + 1;
    }
    if (d.type === "message_end") {
      const m = d.message;
      if (m?.role === "custom" && m?.customType === "subagent-notify") {
        notifyRows += Array.isArray(m?.details?.runs) ? m.details.runs.length : 0;
      }
    }
    if (d.type === "tool_execution_end" && d.toolName === "subagent") {
      if (Array.isArray(d?.details?.results)) toolResults += d.details.results.length;
    }
  }
}
console.log(`\ncaptured ${raw.length} poll payloads`);
console.log("extension_ui_request methods:", JSON.stringify(methods));
console.log("setWidget widgetKeys:", JSON.stringify(widgetKeys));
console.log("subagent-notify details.runs[] rows:", notifyRows);
console.log("subagent tool details.results[] rows:", toolResults);
writeFileSync(join(SHOT_DIR, "idea-subagent-frames.json"), JSON.stringify({ methods, widgetKeys, notifyRows, toolResults, total: raw.length }, null, 2));
