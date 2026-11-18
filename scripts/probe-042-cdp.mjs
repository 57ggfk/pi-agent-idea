/**
 * 042 pre-implementation platform probe, raw-CDP edition.
 *
 * Probes the *existing* JCEF/DevTools surface that 042's implementation plan
 * depends on — DOM/Console/Network coverage, element-inspection helpers,
 * screenshot capture, certificate-control API (043), viewport overrides, and
 * the current token-in-URL isolation status. Everything is a read-only CDP
 * call; no navigation is issued so the token SPA is never disturbed.
 *
 * Reuses the bare page-target WebSocket path proven by probe-033-cdp.mjs
 * (Node >=22 native WebSocket; playwright connectOverCDP is unusable on CEF).
 *
 * Usage: node scripts/probe-042-cdp.mjs [--cdp http://127.0.0.1:9222]
 */
import { setTimeout as sleep } from "node:timers/promises";
import { writeFile } from "node:fs/promises";

const cdpArg = process.argv.indexOf("--cdp");
const CDP_HTTP = cdpArg > -1 ? process.argv[cdpArg + 1] : "http://127.0.0.1:9222";
const OUT = "build/probe-042-result.json";

const results = [];
function check(group, name, ok, detail = "") {
  results.push({ group, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${group}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const pages = targets.filter((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1"));
console.log(`page targets: ${pages.length} → ${pages.map((t) => t.title || t.url).join(" | ")}`);
const page = pages.at(-1);
if (!page) {
  console.error("PROBE-042 FAIL: no Pi Agent page target");
  process.exit(1);
}
const pageUrl = page.url;
console.log(`attached to ${pageUrl.slice(0, 90)}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("ws error"));
});
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg); // include error so we can classify UNSUPPORTED
  }
};
function send(method, params = {}, timeoutMs = 8000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ __timeout: true });
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}
async function evaluate(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.error || res.__timeout) return null;
  if (res.result?.exceptionDetails) return null;
  return res.result?.result?.value;
}
const supported = (msg) => !msg.error && !msg.__timeout;
const errText = (msg) =>
  msg.__timeout ? "timeout" : msg.error ? `${msg.error.code}: ${msg.error.message}` : "";

try {
  // ---- Group 1: DOM contract (page claim) ----
  const dom = await evaluate(
    `JSON.stringify({
      messageList: !!document.querySelector('[data-testid="message-list"]'),
      composer: !!document.querySelector('[data-testid="composer-input"]'),
      tabs: !!document.querySelector('[data-testid="tabs"]'),
      readyState: document.readyState,
      title: document.title
    })`
  );
  const domInfo = dom ? JSON.parse(dom) : {};
  check("DOM", "page contract selectors present",
    !!(domInfo.messageList && domInfo.composer && domInfo.tabs),
    JSON.stringify(domInfo));

  // ---- Group 2: token / isolation status (042 §6.1 hard constraint evidence) ----
  const tokenStatus = await evaluate(
    `JSON.stringify({
      hasToken: /[?&]token=/.test(location.href),
      tokenLen: (location.href.match(/[?&]token=([^&]+)/)||[])[1]?.length ?? 0,
      hasInstance: /[?&]instance=/.test(location.href),
      origin: location.origin
    })`
  );
  const ts = tokenStatus ? JSON.parse(tokenStatus) : {};
  check("ISOLATION", "current bridge panel carries token in URL (baseline fact)",
    ts.hasToken === true,
    JSON.stringify(ts));

  // ---- Group 3: CDP method coverage — DevTools/DOM/Console/Network ----
  const probes = [
    ["DEVTOOLS", "Runtime.evaluate", "Runtime.evaluate", { expression: "1+1", returnByValue: true }],
    ["DEVTOOLS", "Network.enable", "Network.enable", {}],
    ["DEVTOOLS", "Log.enable", "Log.enable", {}],
    ["DEVTOOLS", "Page.captureScreenshot", "Page.captureScreenshot", { format: "png" }],
    ["DEVTOOLS", "Emulation.setDeviceMetricsOverride", "Emulation.setDeviceMetricsOverride",
      { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }],
    ["CERT(043)", "Security.setIgnoreCertificateErrors", "Security.setIgnoreCertificateErrors",
      { ignore: false }],
  ];
  for (const [group, label, method, params] of probes) {
    const msg = await send(method, params);
    check(group, label, supported(msg), supported(msg) ? "supported" : errText(msg));
  }
  // restore viewport override if it worked
  await send("Emulation.clearDeviceMetricsOverride", {});

  // DOM/CSS chain: enable → getDocument (once) → querySelector → CSS.get*.
  // NOTE: DOM.getDocument invalidates all prior nodeIds, so it is called exactly
  // once here and every DOM/CSS call that needs a nodeId follows immediately.
  const domEnable = await send("DOM.enable", {});
  check("DEVTOOLS", "DOM.enable", supported(domEnable),
    supported(domEnable) ? "supported" : errText(domEnable));
  const cssEnable = await send("CSS.enable", {});
  check("DEVTOOLS", "CSS.enable", supported(cssEnable),
    supported(cssEnable) ? "supported" : errText(cssEnable));
  const doc = await send("DOM.getDocument", { depth: -1 });
  check("DEVTOOLS", "DOM.getDocument", supported(doc) && !!doc.result?.root?.nodeId,
    supported(doc) ? `root nodeId=${doc.result?.root?.nodeId}` : errText(doc));
  const rootId = doc.result?.root?.nodeId;
  const qs = await send("DOM.querySelector", {
    nodeId: rootId, selector: '[data-testid="composer-input"]',
  });
  check("DEVTOOLS", "DOM.querySelector", supported(qs) && !!qs.result?.nodeId,
    supported(qs) ? `el nodeId=${qs.result?.nodeId}` : errText(qs));
  const cssParams = { nodeId: qs.result?.nodeId };
  for (const label of ["CSS.getComputedStyleForNode", "CSS.getMatchedStylesForNode"]) {
    const msg = await send(label, cssParams);
    check("DEVTOOLS", label, supported(msg), supported(msg) ? "supported" : errText(msg));
  }

  // ---- Group 4: element-inspection inputs (P2 annotation prerequisites) ----
  const inspect = await evaluate(
    `(() => {
      const el = document.querySelector('[data-testid="composer-input"]') || document.body;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      let cssPath = '';
      try {
        const parts=[]; let n=el;
        while(n && n.nodeType===1 && parts.length<8){
          let s=n.tagName.toLowerCase();
          if(n.id) s+='#'+n.id;
          else if(n.className && typeof n.className==='string') s+='.'+n.className.trim().split(/\\s+/).join('.');
          parts.unshift(s); n=n.parentElement;
        }
        cssPath=parts.join(' > ');
      } catch(e){}
      return JSON.stringify({
        tag: el.tagName, cssPath,
        rect: {w: Math.round(r.width), h: Math.round(r.height)},
        computed: { color: cs.color, fontSize: cs.fontSize, display: cs.display, padding: cs.padding },
        hasShadowRoot: !!el.shadowRoot
      });
    })()`
  );
  const ins = inspect ? JSON.parse(inspect) : {};
  check("ANNOTATE", "stable selector + computed style + rect extractable",
    !!(ins.cssPath && ins.computed && ins.rect), JSON.stringify(ins));

  // ---- Group 5: CSP injection feasibility (P1/P2 injection threat) ----
  const cspOk = await evaluate(
    `JSON.stringify({
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null,
      evalWorks: (()=>{ try{ return eval('1+1')===2; }catch(e){ return false; } })()
    })`
  );
  const csp = cspOk ? JSON.parse(cspOk) : {};
  check("ANNOTATE", "inline script/eval available for annotation overlay",
    csp.evalWorks === true, JSON.stringify(csp));
} catch (e) {
  console.error("PROBE-042 exception:", e.message);
} finally {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nPROBE-042: ${pass}/${results.length} passed`);
  await writeFile(OUT, JSON.stringify({
    capturedAt: new Date().toISOString(),
    cdpHttp: CDP_HTTP,
    pageUrl,
    browser: (await (await fetch(`${CDP_HTTP}/json/version`)).json()),
    results,
  }, null, 2), "utf8");
  console.log(`result → ${OUT}`);
  ws.close();
  process.exit(pass === results.length ? 0 : 1);
}
