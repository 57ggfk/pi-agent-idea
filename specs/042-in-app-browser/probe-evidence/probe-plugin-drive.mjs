// probe-042 plugin drive: measurements against the sandbox IDE (CDP 9223).
// The plugin created windowed + OSR + isolated-ctx browsers with logging
// handlers; this script navigates via CDP and reads outcomes.
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";

const CDP_HTTP = "http://127.0.0.1:9223";
const BASE = "http://127.0.0.1:8771";

async function json(p, opts) { const r = await fetch(`${CDP_HTTP}${p}`, opts); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } }
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map();
    ws.onopen = () => resolve({
      send(m, p = {}) { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { res, rej })); },
      close() { try { ws.close(); } catch {} },
    });
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
    ws.onerror = () => reject(new Error("ws"));
  });
}
async function evalIn(target, expr) {
  const c = await connect(target.webSocketDebuggerUrl);
  try { return (await c.send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value; }
  finally { c.close(); }
}
async function navigate(target, url) {
  const c = await connect(target.webSocketDebuggerUrl);
  try { await c.send("Page.enable"); await c.send("Page.navigate", { url }); } finally { c.close(); }
}

const targets = await json("/json/list");
const fpsTargets = targets.filter((t) => (t.url || "").includes("fps.html"));
const isolated = targets.find((t) => (t.url || "").includes("cookie-read.html"));
const main = fpsTargets[0]; // windowed (created first per plugin log)
if (!main || !isolated) { console.error("targets missing", { main: !!main, isolated: !!isolated }); process.exit(1); }

// ---- 1. cookie isolation ----
await navigate(main, `${BASE}/cookie-set.html`);
await sleep(1500);
const winCookie = await evalIn(main, "document.cookie");
const isoCookie = await evalIn(isolated, "document.cookie");
console.log(`COOKIE | windowed(global ctx) set then read: "${winCookie}"`);
console.log(`COOKIE | isolated ctx read: "${isoCookie}"`);
console.log(`COOKIE | VERDICT: ${isoCookie && isoCookie.includes("probe042") ? "SHARED (isolation NOT effective)" : "ISOLATED (contexts separate!)"}`);

// ---- 2. popup real click on plugin browser (handlers installed) ----
await navigate(main, `${BASE}/popup.html`);
await sleep(1200);
{
  const rect = JSON.parse(await evalIn(main, `JSON.stringify(document.getElementById("pop").getBoundingClientRect().toJSON())`));
  const cx = Math.round(rect.x + rect.width / 2), cy = Math.round(rect.y + rect.height / 2);
  const c = await connect(main.webSocketDebuggerUrl);
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
  c.close();
  await sleep(2000);
  const after = await json("/json/list");
  const child = after.find((x) => (x.url || "").includes("popup-child.html"));
  console.log(`POPUP | trusted click done; child target: ${child ? "EXISTS (" + child.url + ")" : "none"}`);
  if (child) { try { await json(`/json/close/${child.id}`); } catch {} }
}

// ---- 3. self-signed https + handler Continue() ----
await navigate(main, "https://127.0.0.1:8772/");
await sleep(3000);
const certTitle = await evalIn(main, "document.title");
console.log(`CERT | self-signed after handler Continue(): title="${certTitle}" ${certTitle && certTitle.includes("OK") ? "→ PAGE LOADED (proceed path WORKS)" : "→ NOT loaded"}`);

// ---- 4. download with handler ----
fs.mkdirSync("D:/code/probe-042/dl", { recursive: true });
await navigate(main, `${BASE}/download.html`);
await sleep(1200);
{
  const rect = JSON.parse(await evalIn(main, `JSON.stringify(document.getElementById("dl").getBoundingClientRect().toJSON())`));
  const cx = Math.round(rect.x + rect.width / 2), cy = Math.round(rect.y + rect.height / 2);
  const c = await connect(main.webSocketDebuggerUrl);
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
  c.close();
  await sleep(3500);
  const files = fs.readdirSync("D:/code/probe-042/dl");
  console.log(`DOWNLOAD | dl/ files: ${files.length ? files.join(",") : "(none)"}`);
}

// ---- 5. fps readings (as-is; note throttling state) ----
for (const t of await json("/json/list")) {
  if ((t.url || "").includes("fps.html")) console.log(`FPS | ${t.title} (${t.url.includes("fps") ? "still fps.html" : "?"})`);
}
console.log("PLUGIN-DRIVE DONE");
