// probe-042 plugin drive v3: hash-targeted measurements on the windowed browser.
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
async function trustedClick(target, selector) {
  const rect = JSON.parse(await evalIn(target, `JSON.stringify(document.querySelector("${selector}").getBoundingClientRect().toJSON())`));
  const cx = Math.round(rect.x + rect.width / 2), cy = Math.round(rect.y + rect.height / 2);
  const c = await connect(target.webSocketDebuggerUrl);
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
  c.close();
}

const targets = await json("/json/list");
const win = targets.find((t) => (t.url || "").includes("fps.html#win"));
const osr = targets.find((t) => (t.url || "").includes("fps.html#osr"));
const isolated = targets.find((t) => (t.url || "").includes("cookie-read.html"));
if (!win || !osr || !isolated) { console.error("targets missing", { win: !!win, osr: !!osr, isolated: !!isolated }); process.exit(1); }

// ---- 1. popup INTERCEPT on windowed (LifeSpan handler returns true) ----
await navigate(win, `${BASE}/popup.html`);
await sleep(1200);
await trustedClick(win, "#pop");
await sleep(2200);
const after = await json("/json/list");
const child = after.find((x) => (x.url || "").includes("popup-child.html"));
console.log(`POPUP-INTERCEPT | trusted click on #win; child target: ${child ? "EXISTS (intercept FAILED)" : "NONE (popup CANCELLED by handler)"}`);
if (child) { try { await json(`/json/close/${child.id}`); } catch {} }

// ---- 2. download on windowed (DownloadHandler forces save to dl/) ----
fs.mkdirSync("D:/code/probe-042/dl", { recursive: true });
await navigate(win, `${BASE}/download.html`);
await sleep(1200);
await trustedClick(win, "#dl");
await sleep(4000);
const files = fs.readdirSync("D:/code/probe-042/dl");
console.log(`DOWNLOAD | dl/ files: ${files.length ? files.join(",") : "(none)"}`);

// ---- 3. cookie re-verify: windowed sets, isolated reads ----
await navigate(win, `${BASE}/cookie-set.html`);
await sleep(1500);
const winCookie = await evalIn(win, "document.cookie");
const isoCookie = await evalIn(isolated, "document.cookie");
console.log(`COOKIE | windowed(#win, global ctx): "${winCookie}" | isolated ctx: "${isoCookie}"`);
console.log(`COOKIE | VERDICT: ${isoCookie && isoCookie.includes("probe042") ? "SHARED" : "ISOLATED"}`);

// ---- 4. cert proceed on windowed (re-confirm) ----
await navigate(win, "https://127.0.0.1:8772/");
await sleep(3000);
const certTitle = await evalIn(win, "document.title");
console.log(`CERT | self-signed on windowed after Continue(): title="${certTitle}" ${certTitle && certTitle.includes("OK") ? "→ LOADED" : "→ NOT loaded"}`);

// ---- 5. fps state ----
for (const t of await json("/json/list")) {
  if ((t.url || "").includes("fps.html")) console.log(`FPS | ${t.url.endsWith("#win") ? "windowed" : "OSR"} title="${t.title}"`);
}
console.log("DRIVE-V3 DONE");
