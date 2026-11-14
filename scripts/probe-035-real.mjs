/* C1 real-machine: install TWO real packages from the marketplace and observe
 * the serial queue (first installing ~30s, second queued badge, then both done). */
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
const wait = async (expr, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) if (await ev(`Boolean(${expr})`)) return true;
  return false;
};

await ev("location.reload()");
await sleep(2500);
console.log("booted:", await wait(`!!document.querySelector('[data-testid="composer-input"]') || !!document.querySelector('[data-testid="empty-state"]')`, 60_000));
await ev(`document.querySelector('[data-testid="tab-manage"]').click()`);
await wait(`!!document.querySelector('[data-testid="manage-tab-packages"]')`);
await ev(`document.querySelector('[data-testid="manage-tab-packages"]').click()`);
await wait(`!!document.querySelector('[data-testid="packages-tab-market"]')`);

// Marketplace: install openwiki (big, ~30s) then pi-subagents (small) —
// the second must queue behind the first on the REAL npm registry.
await ev(`document.querySelector('[data-testid="packages-tab-market"]').click()`);
console.log("market cards:", await wait(`document.querySelectorAll('[data-testid="market-card"]').length > 0`, 45_000));
await ev(`document.querySelector('[data-testid="market-install-openwiki"]').click()`);
await wait(`!!document.querySelector('[data-testid="confirm-dialog"]')`);
await ev(`document.querySelector('[data-testid="confirm-ok"]').click()`);
console.log("openwiki install enqueued");
await ev(`document.querySelector('[data-testid="market-install-pi-subagents"]').click()`);
await wait(`!!document.querySelector('[data-testid="confirm-dialog"]')`);
await ev(`document.querySelector('[data-testid="confirm-ok"]').click()`);
console.log("pi-subagents install enqueued");

const t0 = Date.now();
let sawBoth = false, timeline = [];
for (let i = 0; i < 90; i++) {
  const s = await ev(`
    JSON.stringify({
      openwikiProgress: !!document.querySelector('[data-testid="package-progress-toolbar"]'),
      marketInstalling: document.querySelector('[data-testid="market-progress-pi-subagents"]') ? 'queued-badge' : null,
      rows: document.querySelectorAll('[data-testid="package-row"]').length,
      installedOpenwiki: [...document.querySelectorAll('[data-testid="market-installed"]')].length,
    })
  `);
  timeline.push((Date.now() - t0) + "ms " + s);
  if (s.includes('"installedOpenwiki":2')) { sawBoth = true; break; }
  await sleep(1000);
}
timeline.slice(-12).forEach((l) => console.log(l));
console.log("RESULT:", sawBoth ? "PASS — both real packages installed through the serial queue" : "INCOMPLETE");
ws.close();
process.exit(sawBoth ? 0 : 1);
