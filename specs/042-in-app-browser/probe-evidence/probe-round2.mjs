// probe-042 round 2: focused follow-ups.
// 1) download: capture loadingFailed errorReason + check where the file went
// 2) cert override: Security.handleCertificateError detailed result
// 3) Browser.setDownloadBehavior availability at page level (documents the playwright failure)
// 4) interstitial page anatomy: is there a Proceed link a user could click?
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CDP_HTTP = "http://127.0.0.1:9222";
const BASE = "http://127.0.0.1:8771";

async function json(p, opts) {
  const res = await fetch(`${CDP_HTTP}${p}`, opts);
  const t = await res.text();
  try { return JSON.parse(t); } catch { return t; }
}
async function newTab(url) {
  let t = await json(`/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return t && t.id ? t : json(`/json/new?url=${encodeURIComponent(url)}`);
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const events = [];
    ws.onopen = () => resolve({
      send(m, p = {}) { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { res, rej })); },
      events, close() { try { ws.close(); } catch {} },
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) events.push(msg);
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}
async function evalIn(target, expr) {
  const c = await connect(target.webSocketDebuggerUrl);
  try { return (await c.send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value; }
  finally { c.close(); }
}
const CREATED = [];

// ---- 1. download errorReason ----
{
  const before = fs.existsSync(path.join(os.homedir(), "Downloads", "probe042.bin"));
  const t = await newTab(`${BASE}/download.html`);
  CREATED.push(t.id);
  await sleep(600);
  const me = (await json("/json/list")).find((x) => x.id === t.id);
  const c = await connect(me.webSocketDebuggerUrl);
  await c.send("Network.enable");
  await c.send("Page.enable");
  await c.send("Runtime.evaluate", { expression: `document.getElementById("dl").click()` });
  await sleep(3500);
  const failed = c.events.filter((e) => e.method === "Network.loadingFailed");
  for (const f of failed) {
    console.log(`DOWNLOAD | loadingFailed | errorText=${f.params.errorText} canceled=${f.params.canceled} blockedReason=${f.params.blockedReason || "-"}`);
  }
  const after = fs.existsSync(path.join(os.homedir(), "Downloads", "probe042.bin"));
  console.log(`DOWNLOAD | file in ~/Downloads: before=${before} after=${after}`);
  // Browser.setDownloadBehavior availability (page-level)
  try {
    const r = await c.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "D:/code/probe-042/dl" });
    console.log(`DOWNLOAD | Browser.setDownloadBehavior page-level: OK ${JSON.stringify(r).slice(0, 60)}`);
  } catch (e) {
    console.log(`DOWNLOAD | Browser.setDownloadBehavior page-level: REJECTED ${String(e.message).slice(0, 100)}`);
  }
  c.close();
}

// ---- 2. cert override detailed ----
{
  const t = await newTab("https://127.0.0.1:8774/");
  CREATED.push(t.id);
  await sleep(400);
  const me = (await json("/json/list")).find((x) => x.id === t.id);
  const c = await connect(me.webSocketDebuggerUrl);
  await c.send("Security.enable");
  await c.send("Security.setOverrideCertificateErrors", { override: true });
  let certError = null, handleErr = null;
  const onMsg = async (msg) => {
    if (msg.method === "Security.certificateError") {
      certError = msg.params;
      try {
        const r = await c.send("Security.handleCertificateError", { eventId: msg.params.eventId, action: "proceed" });
        console.log(`CERT | handleCertificateError result: ${JSON.stringify(r)}`);
      } catch (e) { handleErr = String(e.message); console.log(`CERT | handleCertificateError REJECTED: ${handleErr.slice(0, 150)}`); }
    }
  };
  // piggyback: attach raw listener by wrapping events after navigation
  await c.send("Page.enable");
  const navPromise = c.send("Page.navigate", { url: "https://127.0.0.1:8774/" });
  // manual pump: wait for the event on the socket (handler needs to be attached first)
  await new Promise((res) => {
    const wsPump = setInterval(() => {
      const ev = c.events.find((e) => e.method === "Security.certificateError");
      if (ev) { onMsg(ev); clearInterval(wsPump); res(); }
    }, 50);
    setTimeout(() => { clearInterval(wsPump); res(); }, 4000);
  });
  await navPromise.catch(() => {});
  await sleep(2500);
  const title = (await evalIn(me, "document.title")) || "";
  console.log(`CERT | event=${JSON.stringify(certError).slice(0, 160)}`);
  console.log(`CERT | final pageTitle="${title}" loaded=${title.includes("OK")}`);
  // interstitial anatomy (if still on privacy error)
  const anatomy = await evalIn(me, `(() => {
    const ids = ["details-button","proceed-link","main-content"];
    const found = {};
    for (const id of ids) { const el = document.getElementById(id); if (el) found[id] = { visible: !!(el.offsetParent || el.getClientRects().length), text: (el.textContent||"").trim().slice(0,40) }; }
    found.bodySnippet = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 200);
    return JSON.stringify(found);
  })()`);
  console.log(`CERT | interstitial anatomy: ${anatomy}`);
  c.close();
}

// ---- 3. self-signed interstitial anatomy (user-clickable bypass?) ----
{
  const t = await newTab("https://127.0.0.1:8772/");
  CREATED.push(t.id);
  await sleep(1500);
  const me = (await json("/json/list")).find((x) => x.id === t.id);
  const anatomy = await evalIn(me, `(() => {
    const ids = ["details-button","proceed-link"];
    const found = {};
    for (const id of ids) { const el = document.getElementById(id); if (el) found[id] = (el.textContent||"").trim().slice(0,40); }
    found.err = (document.body ? document.body.innerText : "").match(/ERR_[A-Z_]+/)?.[0] || "-";
    return JSON.stringify(found);
  })()`);
  console.log(`CERT | self-signed interstitial: ${anatomy}`);
}

for (const id of CREATED) { try { await json(`/json/close/${id}`); } catch {} }
console.log("ROUND2 DONE");
