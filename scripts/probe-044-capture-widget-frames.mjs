/**
 * 真机：抓全部 poll 响应，搜 subagent-async / PI_SUBAGENT_ASYNC_JSON / setWidget，
 * 并在抓帧窗口内启动一个新的后台作业，确定性地回答「有作业时帧是否上线」。
 *
 * 用法：node scripts/probe-044-capture-widget-frames.mjs [--cdp http://127.0.0.1:9222]
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
  console.error("no page target");
  process.exit(1);
}

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
async function pointerClick(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(700);
}
async function clickButtonByText(reSource) {
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((e) => ${reSource}.test((e.textContent || '').trim()));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, txt: (el.textContent || '').trim().slice(0, 40) };
  })()`);
  if (!box) return null;
  await pointerClick(box.x, box.y);
  return box.txt;
}

// 1. Capture every poll response, not just the ui-request ones.
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
console.log("✓ capturing all poll payloads");

// 2. Clear the stale approval card (the "Administer worker" select) so pi moves on.
const done = await clickButtonByText("/^Done$/");
console.log("clicked Done:", done);
await sleep(3000);

// 3. Ask pi for a fresh background job, inside the capture window.
const PROMPT =
  "Start another background subagent (async: true) that writes notes/second-check.txt " +
  "containing the text second run. Report the run id as soon as it is started.";
await evaluate(`(() => {
  const el = document.querySelector('[data-testid="composer-input"]');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(PROMPT)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(600);
const sendBox = await evaluate(`(() => {
  const b = document.querySelector('[data-testid="send-btn"]');
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
await pointerClick(sendBox.x, sendBox.y);
console.log("✓ asked pi for a second background job");

// 4. Watch the panel while the capture runs.
for (let i = 0; i < 18; i++) {
  await sleep(5000);
  const jobs = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-testid="panel-job"]')].map((j) => j.innerText.replace(/\\n+/g, ' | ')))`);
  const empty = await evaluate(`!!document.querySelector('[data-testid="panel-jobs-empty"]')`);
  console.log(`  poll ${i + 1}: jobs=${jobs} empty=${empty}`);
  if (jobs && jobs !== "[]") {
    await shot("16-real-second-bg-job");
    break;
  }
}

// 5. Analyze the capture.
const all = JSON.parse(await evaluate("JSON.stringify(window.__all)"));
console.log(`\ncaptured ${all.length} poll payloads`);
let hits = 0;
const widgetFrames = [];
for (const batch of all) {
  if (!batch.includes("setWidget")) continue;
  hits++;
  let obj;
  try { obj = JSON.parse(batch); } catch { continue; }
  for (const entry of obj.events ?? []) {
    const d = entry.record?.data;
    if (d?.method === "setWidget") {
      widgetFrames.push({
        widgetKey: d.widgetKey,
        placement: d.widgetPlacement,
        lines: Array.isArray(d.widgetLines) ? d.widgetLines.map((l) => String(l).slice(0, 1200)) : d.widgetLines,
      });
    }
  }
}
console.log(`payloads mentioning setWidget: ${hits}`);
console.log("setWidget frames:");
for (const f of widgetFrames) {
  console.log("  key:", f.widgetKey, "| placement:", f.placement);
  for (const l of f.lines ?? []) console.log("    line:", String(l).slice(0, 600));
}
const asyncHits = all.filter((b) => b.includes("subagent-async")).length;
const snapshotHits = all.filter((b) => b.includes("PI_SUBAGENT_ASYNC_JSON")).length;
console.log(`\npayloads mentioning subagent-async: ${asyncHits}`);
console.log(`payloads mentioning PI_SUBAGENT_ASYNC_JSON: ${snapshotHits}`);
writeFileSync(
  join(SHOT_DIR, "widget-frames.json"),
  JSON.stringify({ widgetFrames, asyncHits, snapshotHits, totalPayloads: all.length }, null, 2),
);
