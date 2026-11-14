/* 034 live-IDE verification over raw CDP, strict per-step waits. */
import { setTimeout as sleep } from "node:timers/promises";

const CDP_HTTP = "http://127.0.0.1:9222";
const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1"));
if (!page) process.exit(1);
console.log("attached:", page.url.slice(0, 60));

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
const wait = async (expr, ms = 25_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) if (await ev(`Boolean(${expr})`)) return true;
  return false;
};
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const click = async (sel) => {
  if (!(await wait(`!!${q(sel)}`))) throw new Error(`never appeared: ${sel}`);
  await ev(`${q(sel)}.click()`);
};

console.log("bundle:", await ev(`[...document.scripts].map(s=>s.src.split("/").pop()).filter(Boolean).join(",")`));
await ev("location.reload()");
await sleep(2500);
console.log("booted:", await wait(`${q('[data-testid="empty-state"]')} || ${q('[data-testid="composer-input"]')}`, 40_000));

await click('[data-testid="tab-manage"]');
console.log("manage view:", await wait(`${q('[data-testid="manage-view"]')}`, 15_000));

await click('[data-testid="manage-tab-agents"]');
console.log("agents rows:", await wait(`${q('[data-testid="agents-row"]')}`, 15_000));
console.log(await ev(`
  [...document.querySelectorAll('[data-testid="agents-row"]')].slice(0, 3).map((r, i) => 'row' + i + ': ' + JSON.stringify({
    hasPathLine: !!r.querySelector('.skill-path-line'),
    full: r.querySelector('.skill-path-full')?.textContent?.slice(0, 50) ?? null,
    short: r.querySelector('.skill-path-short')?.textContent ?? null,
  })).join('\\n')
`));

await click('[data-testid="manage-tab-skills"]');
console.log("skills rows:", await wait(`${q('[data-testid="skills-panel"]')}`, 15_000), await ev(`document.querySelectorAll('[data-testid="skill-row"]').length`));
console.log(await ev(`
  JSON.stringify({
    groups: [...document.querySelectorAll('[data-testid^="skill-source-"]')].map(e => e.textContent.trim().slice(0, 30)),
    presets: [...document.querySelectorAll('.skill-external-toggle')].map(e => e.textContent.trim().slice(0, 44)),
    banner: document.querySelector('.outcome-banner')?.textContent?.slice(0, 120) ?? null,
    empty: document.querySelector('[data-testid="skills-empty"]')?.textContent?.slice(0, 80) ?? null,
  })
`));
ws.close();
process.exit(0);
