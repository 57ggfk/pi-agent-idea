// probe-042 round 3: download redirect via CDP + cert action strings + interstitial ids
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";

const CDP_HTTP = "http://127.0.0.1:9222";
const BASE = "http://127.0.0.1:8771";
async function json(p, opts) { const r = await fetch(`${CDP_HTTP}${p}`, opts); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } }
async function newTab(url) {
  let t = await json(`/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return t && t.id ? t : json(`/json/new?url=${encodeURIComponent(url)}`);
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map(); const events = [];
    ws.onopen = () => resolve({
      send(m, p = {}) { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { res, rej })); },
      events, close() { try { ws.close(); } catch {} },
    });
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } else if (m.method) events.push(m); };
    ws.onerror = () => reject(new Error("ws"));
  });
}
async function evalIn(target, expr) { const c = await connect(target.webSocketDebuggerUrl); try { return (await c.send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value; } finally { c.close(); } }
const CREATED = [];

// ---- A. setDownloadBehavior BEFORE click → does the file land? ----
fs.mkdirSync("D:/code/probe-042/dl", { recursive: true });
{
  const t = await newTab(`${BASE}/download.html`);
  CREATED.push(t.id);
  await sleep(500);
  const me = (await json("/json/list")).find((x) => x.id === t.id);
  const c = await connect(me.webSocketDebuggerUrl);
  await c.send("Page.enable");
  const r = await c.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "D:/code/probe-042/dl" });
  console.log(`DL2 | setDownloadBehavior: ${JSON.stringify(r)}`);
  await c.send("Runtime.evaluate", { expression: `document.getElementById("dl").click()` });
  await sleep(4000);
  const files = fs.readdirSync("D:/code/probe-042/dl");
  console.log(`DL2 | files in dl/: ${files.length ? files.join(",") : "(none)"}`);
  const failed = c.events.filter((e) => e.method === "Network.loadingFailed");
  console.log(`DL2 | loadingFailed count=${failed.length} ${failed.map((f) => f.params.errorText).join(",")}`);
  c.close();
}

// ---- B. cert action strings ----
{
  const t = await newTab("https://127.0.0.1:8774/");
  CREATED.push(t.id);
  await sleep(400);
  const me = (await json("/json/list")).find((x) => x.id === t.id);
  const c = await connect(me.webSocketDebuggerUrl);
  await c.send("Security.enable");
  await c.send("Security.setOverrideCertificateErrors", { override: true });
  await c.send("Page.enable");
  let lastErrEvent = null, cancelAccepted = false, proceedAccepted = false;
  const pump = setInterval(async () => {
    const ev = c.events.find((e) => e.method === "Security.certificateError" && e.params !== lastErrEvent);
    if (!ev) return;
    lastErrEvent = ev.params;
    try { await c.send("Security.handleCertificateError", { eventId: ev.params.eventId, action: "cancel" }); cancelAccepted = true; } catch (e) { console.log(`CERT2 | cancel REJECTED: ${String(e.message).slice(0, 90)}`); }
    try { await c.send("Security.handleCertificateError", { eventId: ev.params.eventId, action: "proceed" }); proceedAccepted = true; } catch (e) { console.log(`CERT2 | proceed REJECTED: ${String(e.message).slice(0, 90)}`); }
  }, 60);
  await c.send("Page.navigate", { url: "https://127.0.0.1:8774/" }).catch(() => {});
  await sleep(4000);
  clearInterval(pump);
  console.log(`CERT2 | cancelAccepted=${cancelAccepted} proceedAccepted=${proceedAccepted}`);
  const title = (await evalIn(me, "document.title")) || "";
  console.log(`CERT2 | final title="${title}"`);
  const ids = await evalIn(me, `JSON.stringify([...document.querySelectorAll('[id]')].map(e=>e.id).slice(0,25))`);
  const body = (await evalIn(me, `(document.body?document.body.innerText:"").replace(/\\s+/g," ").slice(0,220)`)) || "";
  console.log(`CERT2 | ids=${ids}`);
  console.log(`CERT2 | body="${body}"`);
  c.close();
}

for (const id of CREATED) { try { await json(`/json/close/${id}`); } catch {} }
console.log("ROUND3 DONE");
