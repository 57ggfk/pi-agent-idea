#!/usr/bin/env node
// 0.5.10 real-IDE verification helper (specs 036/037/038/039/040/041/044).
//
// Same plumbing as probe-c3-instances.mjs: page-level native WebSocket CDP
// (ws://127.0.0.1:9222/devtools/page/<id>), no Playwright, no
// connectOverCDP. Evidence JSON lands outside the repo unless P0510_OUT is set.
//
// Usage:
//   node probe-0510-manual.mjs state     page + trust state
//   node probe-0510-manual.mjs 036       diagnostics card readout + settings ~
//   node probe-0510-manual.mjs render    prompt pi for diff/footnote/SVG/math/rust, assert DOM (038/039/040/041 button)
//   node probe-0510-manual.mjs 041       click the IDE button (IDE-side: take a screenshot afterwards)
//   node probe-0510-manual.mjs 044       paste folding in the real composer + send completeness
//   node probe-0510-manual.mjs 037       marketplace link -> system browser, no popup target
//   node probe-0510-manual.mjs all       everything (default)

import { writeFileSync, existsSync } from "node:fs";

const CDP_HTTP = process.env.P0510_CDP || "http://127.0.0.1:9222";
const MODE = process.argv[2] || "all";
const OUT = process.env.P0510_OUT || "";
const SHOT =
  process.env.P0510_SHOT ||
  "C:/Users/Administrator/AppData/Local/Programs/WebStorm/bin/win_shot.py";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};

async function listPages() {
  const res = await fetch(`${CDP_HTTP}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list -> ${res.status}`);
  const all = await res.json();
  return all
    .filter((p) => p.type === "page" && /token=/.test(p.url) && /127\.0\.0\.1/.test(p.url))
    .map((p) => ({ id: p.id, url: p.url, ws: p.webSocketDebuggerUrl }));
}

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
        }, 60000);
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
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval failed"));
  }
  return r.result?.value;
}

async function withPage(fn) {
  const pages = await listPages();
  if (pages.length === 0) throw new Error("no Pi Agent page target — tool window open?");
  const { send, close } = await openPageSocket(pages[0].ws);
  try {
    return await fn(send, pages);
  } finally {
    close();
  }
}

/** DOM-click a testid element (real user-level event inside the page). */
const clickExpr = (tid) => `document.querySelector('[data-testid="${tid}"]').click()`;

async function openManageTab(send, tabId) {
  await evaluate(send, `(() => {
    const tabs = document.querySelector('[data-testid="tabs"]');
    if (!tabs) throw new Error("no tabs element");
    return true;
  })()`);
  await evaluate(send, clickExpr("tab-manage"));
  await sleep(300);
  await evaluate(send, clickExpr(tabId));
  await sleep(600);
}

// -- state ------------------------------------------------------------------

async function probeState() {
  return withPage(async (send) => {
    const basic = await evaluate(send, `(() => {
      const q = (s) => document.querySelector(s);
      return {
        url: location.href.slice(0, 80),
        hasComposer: !!q('[data-testid="composer-input"]'),
        hasTabs: !!q('[data-testid="tabs"]'),
        tabs: [...document.querySelectorAll('[data-testid^="tab-"]')].map((e) => (e.textContent || "").trim()),
        statusDot: q('[data-testid="status-dot"]')?.className ?? null,
        statusVersion: q('[data-testid="status-version"]')?.textContent ?? null,
        bodyLen: document.body.innerText.length,
      };
    })()`);
    await openManageTab(send, "manage-tab-diagnostics");
    const trust = await evaluate(send, `(() => ({
      banner: !!document.querySelector('[data-testid="trust-banner"]'),
      diagnosticsPanel: !!document.querySelector('[data-testid="diagnostics-panel"]'),
    }))()`);
    return { ...basic, trust };
  });
}

// -- 036: diagnostics card + settings ~ shortening ---------------------------

async function probe036() {
  return withPage(async (send) => {
    await openManageTab(send, "manage-tab-diagnostics");
    const diag = await evaluate(send, `(() => {
      const q = (s) => document.querySelector(s);
      const g = (tid) => q('[data-testid="' + tid + '"]')?.textContent?.trim() ?? null;
      return {
        envPanel: !!q('[data-testid="manage-env"]'),
        piVersion: g("pi-version"),
        nodeVersion: g("env-node-version"),
        nodePathFull: g("env-node-path-full"),
        nodePathShort: g("env-node-path-short"),
        nodeMissing: g("env-node-missing"),
        npmVersion: g("env-npm-version"),
        npmPathFull: g("env-npm-path-full"),
        pluginVersion: g("plugin-version"),
        pluginBuild: g("plugin-build"),
        updateBtn: !!q('[data-testid="pi-update"]'),
      };
    })()`);
    // Settings panel: the settings.json path responsive pair (US3).
    await evaluate(send, clickExpr("manage-tab-settings"));
    await sleep(600);
    const settings = await evaluate(send, `(() => ({
      full: document.querySelector('[data-testid="settings-panel"] .skill-path-full')?.textContent?.trim() ?? null,
      short: document.querySelector('[data-testid="settings-panel"] .skill-path-short')?.textContent?.trim() ?? null,
    }))()`);
    return { diag, settings };
  });
}

// -- render round: diff + footnote + svg + math + rust (038/039/040/041) -----

const RENDER_PROMPT = [
  "Reply with exactly these five blocks, nothing else, no commentary:",
  "1) a fenced diff code block containing one line starting with '-' and one line starting with '+', plus one unchanged context line;",
  "2) a sentence with a footnote marker [^note1] and its definition line [^note1]: footnote body text;",
  "3) an inline SVG: <svg viewBox=\"0 0 20 20\" width=\"40\"><circle cx=\"10\" cy=\"10\" r=\"8\" fill=\"green\"></circle></svg>;",
  "4) the inline math $E=mc^2$;",
  "5) a fenced rust code block containing fn main() { println!(\"probe-ok\"); }",
].join(" ");

async function waitForReplySettled(send, timeoutMs = 240000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const done = await evaluate(send, `(() => {
      const root = [...document.querySelectorAll(".markdown")].find((el) => (el.textContent || "").includes("footnote body text"));
      return {
        katex: root ? root.querySelectorAll(".katex").length : 0,
        rust: root ? !!root.querySelector("code.language-rust") : false,
        footnotes: root ? root.querySelectorAll("section.footnotes").length : 0,
      };
    })()`);
    if (done.katex >= 1 && done.rust && done.footnotes >= 1) return { settled: true, waitedMs: Date.now() - start };
    await sleep(3000);
  }
  return { settled: false, waitedMs: timeoutMs };
}

async function probeRender() {
  return withPage(async (send) => {
    // Back to the chat tab (other stages leave the panel on Manage).
    await evaluate(send, clickExpr("tab-chat"));
    await sleep(600);
    // Compose the prompt (applyText-equivalent: set value through the native
    // setter so React picks it up) and send.
    await evaluate(send, `(() => {
      const ta = document.querySelector('[data-testid="composer-input"]');
      if (!ta) throw new Error("no composer");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, ${JSON.stringify(RENDER_PROMPT)});
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return ta.value.length;
    })()`);
    await sleep(300);
    await evaluate(send, `document.querySelector('[data-testid="send-btn"]').click()`);
    const settled = await waitForReplySettled(send);
    const dom = await evaluate(send, `(() => {
      const root = [...document.querySelectorAll(".markdown")].find((el) => (el.textContent || "").includes("footnote body text"));
      if (!root) return { hasRoot: false };
      return {
        hasRoot: true,
        additions: root.querySelectorAll(".hljs-addition").length,
        deletions: root.querySelectorAll(".hljs-deletion").length,
        diffLang: !!root.querySelector("code.language-diff"),
        footnoteRefs: root.querySelectorAll("sup a[data-footnote-ref]").length,
        footnoteSection: !!root.querySelector("section.footnotes"),
        footnoteBody: (root.querySelector("section.footnotes")?.textContent ?? "").includes("footnote body text"),
        svg: root.querySelectorAll("svg").length,
        svgCircle: root.querySelectorAll("svg circle[r='8']").length,
        scripts: root.querySelectorAll("script").length,
        katex: root.querySelectorAll(".katex").length,
        katexDisplay: root.querySelectorAll(".katex-display").length,
        rawEdivM: (root.textContent ?? "").includes("$E=mc^2$"),
        rustBlock: !!root.querySelector("code.language-rust"),
        rustText: (root.querySelector("code.language-rust")?.textContent ?? "").includes("probe-ok"),
        ideButtons: root.querySelectorAll(".code-ide-btn").length,
        copyButtons: root.querySelectorAll(".code-copy-btn").length,
      };
    })()`);
    return { settled, dom };
  });
}

// -- 041: click the IDE button (IDE-side result captured by screenshot) ------

async function probe041() {
  return withPage(async (send) => {
    const before = await evaluate(send, `(() => {
      const root = [...document.querySelectorAll(".markdown")].find((el) => (el.textContent || "").includes("probe-ok"));
      const btns = root ? [...root.querySelectorAll(".code-ide-btn")] : [];
      // Prefer the rust block's button: pick the last (the reply order ends with rust).
      const btn = btns.at(-1);
      if (!btn) throw new Error("no IDE button found");
      return { count: btns.length, label: btn.textContent };
    })()`);
    await evaluate(send, `(() => {
      const btn = [...document.querySelectorAll(".markdown .code-ide-btn")].at(-1);
      btn.click();
      return true;
    })()`);
    await sleep(2500);
    return { clicked: before, note: "check the IDE screenshot for a read-only pi-snippet-*.rs editor tab" };
  });
}

// -- 044: paste folding in the real composer ---------------------------------

async function probe044() {
  return withPage(async (send) => {
    const big = Array.from({ length: 30 }, (_, i) => `probe line ${i} marker-tail-9`).join("\n");
    await evaluate(send, `(() => {
      const ta = document.querySelector('[data-testid="composer-input"]');
      if (!ta) throw new Error("no composer");
      ta.focus();
      return true;
    })()`);
    await evaluate(send, `(async () => {
      const dt = new DataTransfer();
      dt.setData("text/plain", ${JSON.stringify(big)});
      document.querySelector('[data-testid="composer-input"]')
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    await sleep(600);
    const folded = await evaluate(send, `(() => {
      const ta = document.querySelector('[data-testid="composer-input"]');
      return {
        chip: !!document.querySelector('[data-testid="paste-chip"]'),
        value: ta.value,
        height: ta.clientHeight,
      };
    })()`);
    // Expand via a real in-page click on the chip, then collapse back.
    await evaluate(send, `(() => { document.querySelector('[data-testid="paste-chip"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); return true; })()`);
    await sleep(400);
    const expanded = await evaluate(send, `(() => ({
      chip: !!document.querySelector('[data-testid="paste-chip"]'),
      collapseBtn: !!document.querySelector('[data-testid="paste-collapse"]'),
      hasTail: document.querySelector('[data-testid="composer-input"]').value.includes("marker-tail-9"),
      valueLen: document.querySelector('[data-testid="composer-input"]').value.length,
    }))()`);
    await evaluate(send, `(() => { const b = document.querySelector('[data-testid="paste-collapse"]'); if (b) b.click(); return true; })()`);
    await sleep(400);
    const refolded = await evaluate(send, `(() => ({
      chip: !!document.querySelector('[data-testid="paste-chip"]'),
      collapseBtn: !!document.querySelector('[data-testid="paste-collapse"]'),
    }))()`);
    // Send: the transcript must carry the FULL original (FR-007).
    await evaluate(send, `(() => { document.querySelector('[data-testid="send-btn"]').click(); return true; })()`);
    await sleep(3000);
    const sent = await evaluate(send, `(() => {
      const msgs = [...document.querySelectorAll(".markdown")];
      const first = msgs.find((el) => (el.textContent || "").includes("probe line 0"));
      return {
        fullInTranscript: !!first,
        tailVisible: msgs.some((el) => (el.textContent || "").includes("marker-tail-9")),
        tokenLeak: msgs.some((el) => (el.textContent || "").includes("[Pasted Markdown")),
        userMsgLines: first ? (first.textContent.match(/probe line/g) || []).length : 0,
      };
    })()`);
    return { folded, expanded, refolded, sent };
  });
}

// -- 037: marketplace link -> system browser, no JCEF popup -------------------

async function probe037() {
  return withPage(async (send, pages) => {
    const before = { targets: (await listPages()).length };
    await openManageTab(send, "manage-tab-packages");
    await evaluate(send, `(() => {
      const t = document.querySelector('[data-testid="packages-tab-market"]');
      if (!t) throw new Error("market tab missing");
      t.click();
      return true;
    })()`);
    // Cards load from the real registry — give it a moment, then find a link.
    const linkReady = await evaluate(send, `(async () => {
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const a = document.querySelector(".market-link");
        if (a) return { href: a.getAttribute("href"), label: a.textContent.trim() };
        await new Promise((r) => setTimeout(r, 1000));
      }
      return { href: null, label: null };
    })()`);
    if (!linkReady.href) return { skipped: "no market card rendered (registry unreachable?)", linkReady };
    await evaluate(send, `(() => { const links = [...document.querySelectorAll(".market-link")]; const target = links.find((a) => (a.getAttribute("href") || "").includes("pi-subagents")) || links[0]; target.click();; return true; })()`);
    await sleep(4000);
    const after = { targets: (await listPages()).length };
    const panel = await evaluate(send, `(() => ({
      url: location.href.slice(0, 60),
      stillOnMarket: !!document.querySelector(".market-link"),
    }))()`);
    return { link: linkReady, before, after, noNewPopupTarget: after.targets === before.targets, panel };
  });
}

// -- main ---------------------------------------------------------------------

const stages = { state: probeState, "036": probe036, render: probeRender, "041": probe041, "044": probe044, "037": probe037 };

const run = async () => {
  try {
    if (MODE === "all") {
      for (const [name, fn] of Object.entries(stages)) {
        try {
          report[name] = await fn();
        } catch (e) {
          report[name] = { error: String(e.message || e) };
        }
      }
    } else {
      const fn = stages[MODE];
      if (!fn) throw new Error(`unknown stage ${MODE}`);
      report[MODE] = await fn();
    }
  } catch (e) {
    report.fatal = String(e.message || e);
  }
  if (OUT && existsSync(OUT.slice(0, OUT.lastIndexOf("/")))) {
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log("written:", OUT);
  }
  console.log(JSON.stringify(report, null, 2));
};

run();
