// probe-042 round 4: REAL user click via Input.dispatchMouseEvent (trusted
// event, user gesture) → popup default behavior, still zero plugin code.
import { setTimeout as sleep } from "node:timers/promises";

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

const before = await json("/json/list");
const beforeCount = before.filter((t) => t.type === "page").length;

const t = await newTab(`${BASE}/popup.html`);
await sleep(900);
const me = (await json("/json/list")).find((x) => x.id === t.id);
const c = await connect(me.webSocketDebuggerUrl);

// real trusted click on the target=_blank link
const rect = JSON.parse((await c.send("Runtime.evaluate", {
  expression: `JSON.stringify(document.getElementById("pop").getBoundingClientRect().toJSON())`,
  returnByValue: true,
})).result.value);
const cx = Math.round(rect.x + rect.width / 2), cy = Math.round(rect.y + rect.height / 2);
await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
console.log(`POPUP | trusted click at (${cx},${cy}) dispatched`);

await sleep(2500);
const after = await json("/json/list");
const child = after.find((x) => (x.url || "").includes("popup-child.html"));
const pagesNow = after.filter((x) => x.type === "page").length;
console.log(`POPUP | page targets before=${beforeCount} after=${pagesNow}`);
console.log(`POPUP | child target: ${child ? `EXISTS type=${child.type} url=${child.url}` : "none"}`);

// also test window.open with the trusted gesture flag
const openRes = await c.send("Runtime.evaluate", { expression: `(() => { const w = window.open("/popup-child.html", "_blank"); return w === null ? "null(blocked)" : "object(opened)"; })()`, returnByValue: true });
console.log(`POPUP | post-gesture window.open: ${openRes.result.value}`);
await sleep(1500);
const after2 = await json("/json/list");
const child2 = after2.find((x) => (x.url || "").includes("popup-child.html"));
console.log(`POPUP | child after window.open: ${child2 ? `EXISTS type=${child2.type}` : "none"}`);

// cleanup
try { await json(`/json/close/${t.id}`); } catch {}
for (const x of after2) if ((x.url || "").includes("popup-child.html")) { try { await json(`/json/close/${x.id}`); } catch {} }
console.log("ROUND4 DONE");
