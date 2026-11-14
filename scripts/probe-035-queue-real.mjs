/* C1 real-machine: enqueue two removes on REAL packages, observe queue states. */
import { setTimeout as sleep } from "node:timers/promises";

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1"));
if (!page) process.exit(1);
console.log("attached:", page.url.slice(0, 50));

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws")); });
let seq = 0;
const pend = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
};
const ev = async (expression) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  const res = await new Promise((r) => pend.set(id, r));
  if (res.exceptionDetails) return "EXC: " + String(res.exceptionDetails.exception?.description).slice(0, 120);
  return res.result?.value;
};
const wait = async (expr, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) if (await ev(`Boolean(${expr})`)) return true;
  return false;
};

await ev("location.reload()");
await sleep(2500);
console.log("booted:", await wait(`!!document.querySelector('[data-testid="composer-input"]') || !!document.querySelector('[data-testid="empty-state"]')`, 40_000));
await ev(`document.querySelector('[data-testid="tab-manage"]').click()`);
await wait(`!!document.querySelector('[data-testid="manage-tab-packages"]')`);
await ev(`document.querySelector('[data-testid="manage-tab-packages"]').click()`);
console.log("two real rows:", await wait(`document.querySelectorAll('[data-testid="package-row"]').length === 2`, 20_000));
console.log(await ev(`[...document.querySelectorAll('[data-testid="package-row"] .panel-row-title')].map(e=>e.textContent).join(' | ')`));

// Remove BOTH real packages: first remove runs (real npm uninstall ~3-10s),
// second must show the queued badge while the first is in flight.
await ev(`document.querySelectorAll('[data-testid^="package-remove-"]')[1].click()`);
await wait(`!!document.querySelector('[data-testid="confirm-dialog"]')`);
await ev(`document.querySelector('[data-testid="confirm-ok"]').click()`);
await ev(`document.querySelectorAll('[data-testid^="package-remove-"]')[0].click()`);
await wait(`!!document.querySelector('[data-testid="confirm-dialog"]')`);
await ev(`document.querySelector('[data-testid="confirm-ok"]').click()`);

const timeline = [];
const t0 = Date.now();
for (let i = 0; i < 30; i++) {
  const s = await ev(`
    JSON.stringify({
      active: document.querySelector('.pkg-row-active .panel-row-title')?.textContent?.slice(0, 24) ?? null,
      prog: document.querySelector('[data-testid^="package-progress-"]')?.textContent?.slice(0, 24) ?? null,
      queued: [...document.querySelectorAll('.pkg-queued')].map(e => e.textContent).join(',') || null,
      rows: document.querySelectorAll('[data-testid="package-row"]').length,
    })
  `);
  timeline.push((Date.now() - t0) + "ms " + s);
  const done = await ev(`document.querySelectorAll('[data-testid="package-row"]').length === 0`);
  if (done) break;
  await sleep(400);
}
timeline.forEach((l) => console.log(l));
const bothGone = await ev(`document.querySelectorAll('[data-testid="package-row"]').length === 0`);
console.log("RESULT:", bothGone ? "PASS — both real packages removed through the queue" : "FAIL");
ws.close();
process.exit(bothGone ? 0 : 1);
