#!/usr/bin/env node
// 019 / C3 real-IDE verification helper.
//
// Attaches to each JCEF page through its OWN page-level CDP WebSocket
// (ws://127.0.0.1:9222/devtools/page/<id>). Deliberately does NOT use
// Playwright browser-level connectOverCDP: the IDE's OSR JCEF pages are not
// reliably enumerable from the browser target in that mode.
//
// Usage:
//   node probe-c3-instances.mjs pages     list Pi pages + instance ids
//   node probe-c3-instances.mjs state     per-page DOM/URL state
//   node probe-c3-instances.mjs isolate   per-instance ping + bucket isolation
//   node probe-c3-instances.mjs all       everything (default)
//
// Optional: C3_OUT=<path> writes the JSON report to that path (outside the
// repo by default, so no evidence files are ever committed by accident).

import { writeFileSync } from "node:fs";

const CDP_HTTP = process.env.C3_CDP || "http://127.0.0.1:9222";
const MODE = process.argv[2] || "all";
const OUT = process.env.C3_OUT || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => (s ? String(s).slice(0, 6) + "..." : "");

async function listPages() {
  const res = await fetch(`${CDP_HTTP}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list -> ${res.status}`);
  const all = await res.json();
  return all
    .filter((p) => p.type === "page" && /[?&]instance=\d+/.test(p.url))
    .map((p) => {
      const u = new URL(p.url);
      return {
        id: p.id,
        url: p.url,
        instance: Number(u.searchParams.get("instance")),
        token: u.searchParams.get("token"),
        port: u.port,
        ws: p.webSocketDebuggerUrl,
      };
    })
    .sort((a, b) => a.instance - b.instance);
}

/** Returns a CDP send(method, params) function bound to one page socket. */
function openPageSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let next = 1;
    const openTimer = setTimeout(() => reject(new Error(`ws open timeout: ${wsUrl}`)), 8000);

    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = next++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`CDP timeout: ${method}`));
        }, 30000);
        pending.set(id, { resolve: res, reject: rej, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });

    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      resolve({ send, close: () => ws.close() });
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(openTimer);
      reject(new Error(`ws error: ${e?.message || wsUrl}`));
    });
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!m.id || !pending.has(m.id)) return;
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    });
  });
}

async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval failed"),
    );
  }
  return r.result?.value;
}

const STATE_EXPR = `(() => {
  const q = (s) => document.querySelector(s);
  const sp = new URLSearchParams(location.search);
  return {
    href: location.href,
    instance: sp.get("instance"),
    tokenPrefix: (sp.get("token") || "").slice(0, 6),
    title: document.title,
    hasComposer: !!q('[data-testid="composer-input"]'),
    hasMessageList: !!q('[data-testid="message-list"]'),
    hasSetupCard: !!q('[data-testid="setup-card"]'),
    hasTabs: !!q('[data-testid="tabs"]'),
    tabs: [...document.querySelectorAll('[data-testid^="tab-"]')].map((e) => (e.textContent || "").trim()),
    activeTab: document.querySelector('[data-testid^="tab-"][aria-selected="true"]')?.textContent?.trim() ?? null,
    items: document.querySelectorAll('[data-testid="item-user"], [data-testid="item-assistant"]').length,
    statusDot: q('[data-testid="status-dot"]')?.className ?? null,
    statusVersion: q('[data-testid="status-version"]')?.textContent ?? null,
    exitBanner: !!q('[data-testid="exit-banner"]'),
    bodyLen: document.body.innerText.length,
    bodyHead: document.body.innerText.slice(0, 160),
  };
})()`;

async function pageState(page) {
  const { send, close } = await openPageSocket(page.ws);
  try {
    return await evaluate(send, STATE_EXPR);
  } finally {
    close();
  }
}

async function pagePost(page, path, body) {
  const { send, close } = await openPageSocket(page.ws);
  try {
    const expr = `(async () => {
      const sp = new URLSearchParams(location.search);
      const t = sp.get("token"), i = sp.get("instance");
      const url = ${JSON.stringify(path)} + (${JSON.stringify(path)}.includes("?") ? "&" : "?") + "instance=" + i;
      const r = await fetch(url, ${body ? `{
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pi-Token": t },
        body: JSON.stringify(${JSON.stringify(body)}),
      }` : `{ headers: { "X-Pi-Token": t } }`});
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text: text.slice(0, 400) };
    })()`;
    return await evaluate(send, expr);
  } finally {
    close();
  }
}

async function main() {
  const report = {
    capturedAt: new Date().toISOString(),
    mode: MODE,
    cdp: CDP_HTTP,
    pages: [],
    states: {},
    isolation: null,
    errors: [],
  };

  const pages = await listPages();
  report.pages = pages.map((p) => ({
    id: p.id,
    instance: p.instance,
    url: p.url.replace(/([?&]token=)[^&#]*/gi, "$1<redacted>"),
    tokenPrefix: redact(p.token),
    port: p.port,
  }));

  if (MODE === "pages") return finish(report);

  if (MODE === "state" || MODE === "all") {
    for (const p of pages) {
      try {
        const st = await pageState(p);
        st.href = st.href.replace(/([?&]token=)[^&#]*/gi, "$1<redacted>");
        report.states[p.instance] = st;
      } catch (e) {
        report.errors.push(`state(instance=${p.instance}): ${e.message}`);
      }
    }
  }

  // Start a real (short) pi run on one instance so the IDE-side close guard
  // can be exercised while streaming. Purely diagnostic: it reports whether
  // pi emitted agent_start without a matching agent_settled.
  if (MODE === "stream") {
    const target = Number(process.argv[3] || 0);
    const page = pages.find((p) => p.instance === target);
    if (!page) throw new Error(`instance ${target} has no CDP page`);
    const id = `c3-stream-i${target}-${Date.now()}`;
    const prompt =
      "Write a numbered list from 1 to 120, one number per line. Output only the numbers.";
    const post = await pagePost(page, "/bridge", {
      t: "rpc.request",
      id,
      p: { command: { type: "prompt", message: prompt }, timeoutMs: 180000 },
    });
    report.stream = { target, id, post, samples: [], streamingNow: false };
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(800);
      const { send, close } = await openPageSocket(page.ws);
      let snap;
      try {
        snap = await evaluate(
          send,
          `(async () => {
            const sp = new URLSearchParams(location.search);
            const r = await fetch('/bridge/poll?cursor=0&timeout=0&instance=' + sp.get('instance'),
              { headers: { 'X-Pi-Token': sp.get('token') } });
            const j = await r.json();
            const piEvents = j.events
              .filter((e) => e.record && e.record.name === 'pi')
              .map((e) => ({ seq: e.seq, type: e.record.data?.type }));
            return {
              cursor: j.cursor,
              eventCount: j.events.length,
              piEvents: piEvents.slice(-14),
              startCount: piEvents.filter((e) => e.type === 'agent_start').length,
              settledCount: piEvents.filter((e) => e.type === 'agent_settled').length,
              items: document.querySelectorAll('[data-testid="item-user"], [data-testid="item-assistant"]').length,
              bodyHead: document.body.innerText.slice(0, 180),
            };
          })()`,
        );
      } finally {
        close();
      }
      report.stream.samples.push({ t: Date.now(), ...snap });
      report.stream.streamingNow = snap.startCount > snap.settledCount;
      if (report.stream.streamingNow) break;
    }
    return finish(report);
  }

  if (MODE === "isolate" || MODE === "all") {
    const stamp = Date.now();
    const pingIds = {};
    for (const p of pages) pingIds[p.instance] = `c3-ping-i${p.instance}-${stamp}`;

    const posts = {};
    for (const p of pages) {
      try {
        posts[p.instance] = await pagePost(p, "/bridge", {
          t: "ping",
          id: pingIds[p.instance],
          p: {},
        });
      } catch (e) {
        posts[p.instance] = { error: e.message };
      }
    }
    // Bridge dispatch is async (scope.launch); give it a moment to push.
    await sleep(900);

    const buckets = {};
    for (const p of pages) {
      try {
        const r = await pagePost(p, "/bridge/poll?cursor=0&timeout=0", null);
        const events = r.json?.events ?? [];
        const ids = events
          .map((e) => e.record?.id)
          .filter((x) => typeof x === "string");
        const own = pingIds[p.instance];
        const others = Object.entries(pingIds)
          .filter(([k]) => Number(k) !== p.instance)
          .map(([, v]) => v);
        buckets[p.instance] = {
          status: r.status,
          cursor: r.json?.cursor ?? null,
          oldest: r.json?.oldest ?? null,
          eventCount: events.length,
          ownPingFound: ids.includes(own),
          otherPingsFound: others.filter((x) => ids.includes(x)),
          tailIds: ids.slice(-10),
          lastRecords: events.slice(-3).map((e) => ({
            seq: e.seq,
            t: e.record?.t,
            name: e.record?.name,
            id: e.record?.id,
            ok: e.record?.ok,
          })),
        };
      } catch (e) {
        buckets[p.instance] = { error: e.message };
      }
    }

    const pass = Object.entries(buckets).every(
      ([, b]) => b.ownPingFound === true && Array.isArray(b.otherPingsFound) && b.otherPingsFound.length === 0,
    );
    report.isolation = { pingIds, posts, buckets, pass };
  }

  return finish(report);
}

function finish(report) {
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (OUT) writeFileSync(OUT, text, "utf8");
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: e.message, stack: e.stack }, null, 2));
  process.exit(1);
});
