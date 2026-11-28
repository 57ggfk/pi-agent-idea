/**
 * 真机：抓真实 IDEA 里 bridge poll 的全部载荷，找 extension_ui_request /
 * setWidget / subagent-async —— 定位「后台任务分区空白」是帧没到、还是帧到了没解析。
 *
 * 用法：node scripts/probe-046-why-jobs-empty.mjs [--cdp http://127.0.0.1:9222]
 */
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const cdpArg = process.argv.indexOf("--cdp");
const CDP_HTTP = cdpArg > -1 ? process.argv[cdpArg + 1] : "http://127.0.0.1:9222";

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

// Tap every poll response.
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
console.log("✓ tapping poll payloads; asking pi to start a background subagent…");

// Ask pi to start a background subagent so a snapshot WITH jobs must arrive.
const PROMPT =
  "Start a background subagent (async: true) that writes notes/agent-check.txt containing " +
  "the text agent ran. Report the run id as soon as it is started; do not wait for it.";
await evaluate(`(() => {
  const el = document.querySelector('[data-testid="composer-input"]');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(PROMPT)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(700);
const box = await evaluate(`(() => {
  const b = document.querySelector('[data-testid="send-btn"]');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
if (box) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  console.log("✓ prompt sent");
}

for (let i = 0; i < 24; i++) {
  await sleep(5000);
  const state = await evaluate(`(() => {
    const p = document.querySelector('[data-testid="status-panel"]');
    if (!p) return { open: false };
    return {
      open: true,
      jobs: [...p.querySelectorAll('[data-testid="panel-job"]')].map((j) => j.innerText.replace(/\\n+/g, ' | ')),
      empty: !!p.querySelector('[data-testid="panel-jobs-empty"]'),
      pending: [...p.querySelectorAll('[data-testid="panel-pending-item"]')].map((i) => i.innerText.replace(/\\n+/g, ' | ')),
    };
  })()`);
  console.log(`  poll ${i + 1}: ${JSON.stringify(state).slice(0, 260)}`);
  if ((state.jobs ?? []).length > 0) {
    console.log("✓ 作业行出现");
    break;
  }
}

const raw = JSON.parse(await evaluate("JSON.stringify(window.__all)"));
console.log(`\ncaptured ${raw.length} poll payloads`);
const methods = {};
const widgetKeys = {};
let asyncLine = null;
for (const batch of raw) {
  let obj;
  try { obj = JSON.parse(batch); } catch { continue; }
  for (const entry of obj.events ?? []) {
    const d = entry.record?.data;
    if (!d || typeof d !== "object") continue;
    if (d.type === "extension_ui_request") {
      methods[d.method] = (methods[d.method] ?? 0) + 1;
      if (d.method === "setWidget") {
        widgetKeys[d.widgetKey ?? "(none)"] = (widgetKeys[d.widgetKey ?? "(none)"] ?? 0) + 1;
        const line = Array.isArray(d.widgetLines) ? d.widgetLines[0] : null;
        if (typeof line === "string" && line.includes("PI_SUBAGENT_ASYNC_JSON") && !asyncLine) {
          asyncLine = line;
        }
      }
    }
  }
}
console.log("extension_ui_request methods:", JSON.stringify(methods));
console.log("setWidget widgetKeys:", JSON.stringify(widgetKeys));
console.log("payloads mentioning subagent-async:", raw.filter((b) => b.includes("subagent-async")).length);
console.log("payloads mentioning PI_SUBAGENT_ASYNC_JSON:", raw.filter((b) => b.includes("PI_SUBAGENT_ASYNC_JSON")).length);
if (asyncLine) console.log("\nfirst snapshot line:\n" + asyncLine.slice(0, 1500));
writeFileSync(
  join(process.cwd(), "build", "verify-screenshots", "idea-frames.json"),
  JSON.stringify({ methods, widgetKeys, total: raw.length }, null, 2),
);
