// probe-042: real-machine JCEF probes via page-level bare CDP.
// Temporary exploration asset for spec 042 (in-app browser) — NOT part of the
// plugin repo. Prereq: real WebStorm running with -Dide.browser.jcef.debug.port=9222
// and the local test server: node server.mjs
// Usage: node probe.mjs [--cdp http://127.0.0.1:9222]
import { setTimeout as sleep } from "node:timers/promises";

const cdpArg = process.argv.indexOf("--cdp");
const CDP_HTTP = cdpArg > -1 ? process.argv[cdpArg + 1] : "http://127.0.0.1:9222";
const BASE = "http://127.0.0.1:8771";

const R = [];
function rec(name, ok, detail = "") {
  R.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
}
const CREATED = [];

async function json(path, opts) {
  const res = await fetch(`${CDP_HTTP}${path}`, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// /json/new on Chrome >=111 requires PUT; fall back to GET for older CEF.
async function newTab(url) {
  let t = await json(`/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (t && t.id) return t;
  t = await json(`/json/new?url=${encodeURIComponent(url)}`);
  return t && t.id ? t : null;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const events = [];
    const handlers = [];
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = ++seq;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej }));
      },
      events, handlers,
      close() { try { ws.close(); } catch {} },
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        events.push(msg);
        for (const h of handlers) h(msg);
      }
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}

async function evalIn(target, expression) {
  const c = await connect(target.webSocketDebuggerUrl);
  try {
    const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  } finally { c.close(); }
}

// ---------- phase 0: baseline ----------
const version = await json("/json/version");
console.log(`# CDP version: ${version.Browser} | proto ${version["Protocol-Version"]}`);
const baseTargets = await json("/json/list");
const basePages = baseTargets.filter((t) => t.type === "page");
console.log(`# baseline page targets: ${basePages.map((t) => t.title.slice(0, 30)).join(" | ")}`);

// ---------- phase 1: console/network capture shape ----------
{
  const t = await newTab(`${BASE}/console.html`);
  CREATED.push(t.id);
  await sleep(1200);
  const live = await json("/json/list");
  const me = live.find((x) => x.id === t.id);
  if (!me) rec("new-tab via /json/new", false, "target vanished");
  else {
    rec("new-tab via /json/new", true, `url=${me.url}`);
    const c = await connect(me.webSocketDebuggerUrl);
    await c.send("Runtime.enable");
    await c.send("Log.enable");
    await c.send("Network.enable");
    await sleep(2000);
    const consoleEv = c.events.filter((e) => e.method === "Runtime.consoleAPICalled");
    const logEv = c.events.filter((e) => e.method === "Log.entryAdded");
    const netEv = c.events.filter((e) => e.method.startsWith("Network."));
    rec("console capture: Runtime.consoleAPICalled", consoleEv.length >= 5,
      `count=${consoleEv.length} types=${consoleEv.map((e) => e.params.type).join(",")}`);
    if (consoleEv.length) {
      const sample = consoleEv[0].params;
      rec("console event shape", true, `keys=${Object.keys(sample).join(",")} args0=${JSON.stringify(sample.args?.[0]).slice(0, 80)}`);
    }
    rec("console capture: Log.entryAdded", logEv.length >= 0, `count=${logEv.length}`);
    rec("network events captured", netEv.length > 0, `count=${netEv.length}`);
    const exceptionEv = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    rec("uncaught exceptions visible", exceptionEv.length >= 0, `count=${exceptionEv.length}`);
    c.close();
  }
}

// ---------- phase 2: element picking / computed styles / selectors / screenshot ----------
{
  const t = await newTab(`${BASE}/element.html`);
  CREATED.push(t.id);
  await sleep(800);
  const live = await json("/json/list");
  const me = live.find((x) => x.id === t.id);
  const c = await connect(me.webSocketDebuggerUrl);
  const expr = `(() => {
    const el = document.querySelector("#target-button");
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) seg += "#" + cur.id;
      else if (cur.className) seg += "." + String(cur.className).trim().split(/\\s+/).join(".");
      const sibs = Array.from(cur.parentNode.children).filter((s) => s.tagName === cur.tagName);
      if (!cur.id && sibs.length > 1) seg += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const style = {};
    for (const p of ["display","position","color","background-color","font-size","font-weight","margin","padding","border"]) style[p] = cs[p];
    const text = el.textContent.trim().slice(0, 200);
    return JSON.stringify({ selector: parts.join(" > "), style, rect: {x:r.x,y:r.y,w:r.width,h:r.height}, text });
  })()`;
  const raw = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  const data = JSON.parse(raw.result.value);
  rec("stable selector generation", data.selector.includes("#target-button"), data.selector);
  rec("computed styles (9 props)", Object.keys(data.style).length === 9, JSON.stringify(data.style).slice(0, 120));
  rec("element rect", data.rect.w > 0, JSON.stringify(data.rect));
  rec("visible text (200 char cap)", data.text === "Click me", data.text);
  await c.send("Page.enable");
  try {
    const shot = await c.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: data.rect.x, y: data.rect.y, width: data.rect.w, height: data.rect.h, scale: 1 },
    });
    rec("clipped screenshot (Page.captureScreenshot)", (shot.data || "").length > 100, `png bytes≈${Math.floor(shot.data.length * 3 / 4)}`);
  } catch (e) {
    rec("clipped screenshot (Page.captureScreenshot)", false, String(e.message).slice(0, 120));
  }
  c.close();
}

// ---------- phase 3: CSP vs injection channels ----------
{
  const t = await newTab(`${BASE}/csp.html`);
  CREATED.push(t.id);
  await sleep(800);
  const live = await json("/json/list");
  const me = live.find((x) => x.id === t.id);
  const c = await connect(me.webSocketDebuggerUrl);
  const csp = await c.send("Runtime.evaluate", { expression: "document.querySelector('meta[http-equiv]').content", returnByValue: true });
  rec("CSP meta present", (csp.result.value || "").includes("script-src 'none'"), csp.result.value);
  const viaCdp = await c.send("Runtime.evaluate", { expression: 'window.__p42 = 1; 2 + 3', returnByValue: true });
  rec("CDP Runtime.evaluate bypasses CSP", viaCdp.result.value === 5, `value=${viaCdp.result.value}`);
  const viaDom = await c.send("Runtime.evaluate", { expression: `(() => {
    const s = document.createElement("script");
    s.textContent = "window.__p42dom = 1";
    document.head.appendChild(s);
    return window.__p42dom === 1;
  })()`, returnByValue: true });
  rec("DOM <script> injection blocked by CSP", viaDom.result.value === false, `injected=${viaDom.result.value}`);
  c.close();
}

// ---------- phase 4: cookie jar sharing across targets ----------
{
  const t1 = await newTab(`${BASE}/cookie-set.html`);
  CREATED.push(t1.id);
  await sleep(1000);
  const t2 = await newTab(`${BASE}/cookie-read.html`);
  CREATED.push(t2.id);
  await sleep(800);
  const live = await json("/json/list");
  const a = live.find((x) => x.id === t1.id);
  const b = live.find((x) => x.id === t2.id);
  const v1 = await evalIn(a, "document.cookie");
  const v2 = await evalIn(b, "document.cookie");
  rec("cookie set visible in own tab", (v1 || "").includes("probe042=hello"), v1);
  rec("cookie SHARED across two /json/new targets (same request context)", (v2 || "").includes("probe042=hello"), v2);
}

// ---------- phase 5: popup (target=_blank) default behavior ----------
{
  const t = await newTab(`${BASE}/popup.html`);
  CREATED.push(t.id);
  await sleep(800);
  const live = await json("/json/list");
  const me = live.find((x) => x.id === t.id);
  const c = await connect(me.webSocketDebuggerUrl);
  const openRes = await c.send("Runtime.evaluate", { expression: `(() => { const w = window.open("/popup-child.html", "_blank"); return w === null ? "null(blocked)" : (w.closed ? "closed" : "object(opened)"); })()`, returnByValue: true });
  await sleep(1500);
  const after = await json("/json/list");
  const child = after.find((x) => (x.url || "").includes("popup-child.html"));
  rec("window.open from CDP-injected call", true, `result=${openRes.result.value} childTarget=${child ? "EXISTS(" + child.type + ")" : "none"}`);
  rec("popup behavior note", true, "CDP-injected lacks user gesture; real-click behavior needs plugin-level probe (onBeforePopup)");
  c.close();
}

// ---------- phase 6: download default behavior ----------
{
  const t = await newTab(`${BASE}/download.html`);
  CREATED.push(t.id);
  await sleep(800);
  const live = await json("/json/list");
  const me = live.find((x) => x.id === t.id);
  const c = await connect(me.webSocketDebuggerUrl);
  await c.send("Network.enable");
  await c.send("Runtime.evaluate", { expression: `document.getElementById("dl").click()` });
  await sleep(4000);
  const dlEv = c.events.filter((e) => e.method.startsWith("Network.") && /loadingFinished|loadingFailed/.test(e.method));
  rec("download click → network activity", dlEv.length > 0, `events=${dlEv.map((e) => e.method).join(",")}`);
  c.close();
  rec("download landing check", true, "checked externally in Downloads dir after run (see report)");
}

// ---------- phase 7: HTTPS certificate errors (three classes + page-level override attempt) ----------
for (const [label, port] of [["self-signed (CN=127.0.0.1)", 8772], ["wrong-domain (CN=other.example.com)", 8773], ["private-CA signed", 8774]]) {
  const t = await newTab(`https://127.0.0.1:${port}/`);
  CREATED.push(t.id);
  await sleep(1800);
  const live = await json("/json/list");
  const me = live.find((x) => x.id === t.id);
  if (!me) { rec(`https ${label}: default behavior`, false, "target vanished"); continue; }
  let title = "", body = "";
  try {
    title = (await evalIn(me, "document.title")) || "";
    body = ((await evalIn(me, "document.body ? document.body.innerText.slice(0,120) : ''")) || "").replace(/\n/g, " ");
  } catch (e) { body = String(e.message).slice(0, 100); }
  const loaded = title.includes("OK");
  rec(`https ${label}: default (no handler)`, true, `${loaded ? "PAGE LOADED" : "error page"} | title="${title}" body="${body.slice(0, 90)}"`);
}
// page-level Security override attempt on private-CA
{
  const t = await newTab("https://127.0.0.1:8774/");
  CREATED.push(t.id);
  await sleep(500);
  const live = await json("/json/list");
  const me = live.find((x) => x.id === t.id);
  const c = await connect(me.webSocketDebuggerUrl);
  let overrideWorked = false, certErrorSeen = false;
  try {
    await c.send("Security.enable");
    await c.send("Security.setOverrideCertificateErrors", { override: true });
    c.handlers.push(async (msg) => {
      if (msg.method === "Security.certificateError") {
        certErrorSeen = true;
        try {
          await c.send("Security.handleCertificateError", { eventId: msg.params.eventId, action: "proceed" });
          overrideWorked = true;
        } catch {}
      }
    });
    await c.send("Page.enable");
    await c.send("Page.navigate", { url: "https://127.0.0.1:8774/" });
    await sleep(2500);
    const title = (await evalIn(me, "document.title")) || "";
    rec("page-level Security.handleCertificateError(proceed)", title.includes("OK") || overrideWorked,
      `certErrorEvent=${certErrorSeen} pageTitle="${title}"`);
  } catch (e) {
    rec("page-level Security.handleCertificateError(proceed)", false, String(e.message).slice(0, 120));
  }
  c.close();
}

// ---------- phase 8: teardown ----------
for (const id of CREATED) {
  try { await json(`/json/close/${id}`); } catch {}
}
console.log(`\n# closed ${CREATED.length} probe tabs`);
console.log("# SUMMARY " + JSON.stringify(R.map((r) => ({ n: r.name, ok: r.ok })), null, 0).slice(0, 4000));
