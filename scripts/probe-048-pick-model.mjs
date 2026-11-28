/**
 * 真机：用真实指针点开模型选择器，换到本机 magpie provider，再触发后台 subagent。
 * 用法：node scripts/probe-048-pick-model.mjs [--cdp http://127.0.0.1:9222]
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
/** Real pointer click at the element's centre. */
async function pointerClickAtElement(selector, textMatcher) {
  const box = await evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = ${textMatcher ? `els.find((e) => ${textMatcher}.test((e.textContent || '')))` : "els[0]"};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, txt: (el.textContent || '').trim().slice(0, 60) };
  })()`);
  if (!box) return null;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(800);
  return box;
}

console.log("model chip before:", await evaluate(`document.querySelector('[data-testid="model-chip"]')?.textContent ?? ''`));
await pointerClickAtElement('[data-testid="model-chip"]');
await sleep(1500);
await shot("40-model-picker-open");

const options = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-testid="model-option"]')]
  .map((e) => (e.textContent || '').trim().slice(0, 70)).slice(0, 10))`);
console.log("options:", options);

// Pick the first magpie-family option (DeepSeek V4 Pro · routing group).
const picked = await pointerClickAtElement('[data-testid="model-option"]', "/magpie|DeepSeek/i");
console.log("picked:", JSON.stringify(picked));
await sleep(2500);
console.log("model chip after:", await evaluate(`document.querySelector('[data-testid="model-chip"]')?.textContent ?? ''`));
await shot("41-model-picked");
