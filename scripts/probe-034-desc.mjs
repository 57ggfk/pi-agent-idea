/* Live check: block-scalar descriptions on the real skills panel. */
import { setTimeout as sleep } from "node:timers/promises";

const CDP_HTTP = "http://127.0.0.1:9222";
const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
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
const wait = async (expr, ms = 45_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) if (await ev(`Boolean(${expr})`)) return true;
  return false;
};

await sleep(2000);
await ev(`document.querySelector('[data-testid="tab-manage"]')?.click()`);
await wait(`!!document.querySelector('[data-testid="manage-tab-skills"]')`);
await ev(`document.querySelector('[data-testid="manage-tab-skills"]').click()`);
console.log("rows loaded:", await wait(`document.querySelectorAll('[data-testid="skill-row"]').length > 0`, 45_000));
const out = await ev(`
  [...document.querySelectorAll('[data-testid="skill-row"]')]
    .filter(r => /subagents|orchestration/.test(r.textContent))
    .map(r => {
      const name = r.querySelector('.panel-row-title')?.childNodes[0]?.textContent?.trim();
      const desc = r.querySelector('.skill-desc')?.textContent?.slice(0, 70) ?? 'NONE';
      const title = r.querySelector('.skill-desc')?.getAttribute('title')?.slice(0, 100) ?? 'NONE';
      return name + '\\n  desc: ' + desc + '\\n  title: ' + title;
    })
    .join('\\n')
`);
console.log(out);
ws.close();
process.exit(0);
