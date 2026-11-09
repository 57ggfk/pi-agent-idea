/**
 * 018 real-IDE smoke (no model call) — raw CDP driver.
 *
 * playwright's connectOverCDP handshakes with Browser.setDownloadBehavior,
 * which JCEF's CDP implementation rejects ("Browser context management is not
 * supported"), so this harness speaks CDP over a page-level WebSocket itself.
 *
 * Prerequisite: `PI_IDE_E2E=real PI_IDE_E2E_PROJECT=<project> ./gradlew runIde`
 * (CDP :9222 + auto-opened tool window + the user's real pi binary).
 * Usage: node scripts/smoke-018.mjs [--cdp http://127.0.0.1:9222]
 *
 * Covers: inline ref chips (paste), the markdown paste misfire fix, @ menu,
 * composer image card + preview modal, message-table borders, model group
 * collapse, packages update-all button. Send/model behaviour is NOT exercised
 * here — use e2e-ide-real.mjs for the full real-model round trip.
 */
const cdpArg = process.argv.indexOf("--cdp");
const CDP = cdpArg > -1 ? process.argv[cdpArg + 1] : "http://127.0.0.1:9222";
// `--real-model` adds one real prompt round trip through the NEW send path
// (raw text incl. any inline tokens) and waits for the model's reply.
const REAL_MODEL = process.argv.includes("--real-model");
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const fail = (message) => {
  console.error(`SMOKE-018 FAIL: ${message}`);
  process.exit(1);
};

// -- minimal CDP-over-WebSocket client ----------------------------------------

const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1"));
if (!target) fail(`Pi Agent page not found on CDP targets: ${list.map((t) => t.url).join(", ")}`);
console.log(`attached to ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("ws error"));
});

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

/** Evaluates an expression in the page; objects come back by value. */
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page exception");
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // A previous run may have left the tool window on another tab.
  await evalJs(`document.querySelector('[data-testid="tab-chat"]')?.click()`);
  const booted = await evalJs(`!!document.querySelector('[data-testid="composer-input"]')`);
  if (!booted) {
    // The tool window may still be booting — poll for up to 45s.
    let up = false;
    for (let i = 0; i < 45 && !up; i++) {
      await sleep(1000);
      await evalJs(`document.querySelector('[data-testid="tab-chat"]')?.click()`);
      up = await evalJs(`!!document.querySelector('[data-testid="composer-input"]')`);
    }
    if (!up) fail("composer-input never appeared");
  }
  ok("UI booted", true);

  // -- US1 + US3: paste paths and markdown ------------------------------------
  const absPath = "/Volumes/code/github/pi-agent-idea/web/src/main.tsx";
  await evalJs(`(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", ${JSON.stringify(absPath)});
    document.querySelector('[data-testid="composer-input"]')
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  let token = null;
  for (let i = 0; i < 40 && !token; i++) {
    await sleep(250);
    token = await evalJs(`document.querySelector('[data-testid="ref-token"]')?.getAttribute("data-path") ?? null`);
  }
  ok("US1 single-path paste becomes an inline token", token === "web/src/main.tsx", `data-path=${token}`);
  const pillInFlow = await evalJs(`!!document.querySelector('[data-testid="ref-token"]')?.closest(".composer-input-wrap")`);
  ok("US1 pill renders inside the input wrap (text flow)", !!pillInFlow);
  const rawText = await evalJs(`document.querySelector('[data-testid="composer-input"]').value`);
  ok("US1 textarea keeps the raw @path text", rawText.includes("@web/src/main.tsx "), JSON.stringify(rawText.slice(0, 40)));

  await evalJs(`(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
  })()`);
  await sleep(300);
  const afterBackspace = await evalJs(`document.querySelector('[data-testid="composer-input"]').value`);
  ok("US1 one Backspace removes the whole pill", afterBackspace === "", JSON.stringify(afterBackspace));

  const md = "# title\\n./gradlew buildPlugin\\nsee /usr/local/bin/pi\\nuser@example.com";
  await evalJs(`(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", ${JSON.stringify("# title\n./gradlew buildPlugin\nsee /usr/local/bin/pi\nuser@example.com")});
    document.querySelector('[data-testid="composer-input"]')
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await sleep(500);
  const mdTokens = await evalJs(`document.querySelectorAll('[data-testid="ref-token"]').length`);
  ok("US3 multi-line markdown paste creates zero tokens", mdTokens === 0, `tokens=${mdTokens}`);
  void md;

  // -- @ menu over real project files ------------------------------------------
  await evalJs(`(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "看@main");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  let menuUp = false;
  for (let i = 0; i < 20 && !menuUp; i++) {
    await sleep(250);
    menuUp = await evalJs(`!!document.querySelector('[data-testid="file-menu"]')`);
  }
  ok("@ completion menu opens (CJK prefix)", menuUp);
  await evalJs(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);

  // -- US2: image card + preview modal ------------------------------------------
  await evalJs(`(() => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "smoke.png", { type: "image/png" }));
    document.querySelector('[data-testid="composer-input"]')
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  let card = false;
  for (let i = 0; i < 20 && !card; i++) {
    await sleep(250);
    card = await evalJs(`!!document.querySelector('[data-testid="image-card"]')`);
  }
  ok("US2 pasted image becomes a thumbnail card", card);
  if (card) {
    await evalJs(`document.querySelector('[data-testid="image-card"] img').click()`);
    let dialog = false;
    for (let i = 0; i < 10 && !dialog; i++) {
      await sleep(200);
      dialog = await evalJs(`!!document.querySelector('[data-testid="image-preview-dialog"]')`);
    }
    const counter = dialog ? await evalJs(`document.querySelector('[data-testid="image-preview-count"]').innerText`) : "n/a";
    ok("US2 card click opens the preview modal", dialog, counter);
    await evalJs(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  }

  // -- US4: table borders --------------------------------------------------------
  const border = await evalJs(`(() => {
    const host = document.querySelector(".message-list") ?? document.body;
    const div = document.createElement("div");
    div.className = "markdown";
    div.innerHTML = "<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>C</td></tr></tbody></table>";
    div.style.position = "absolute";
    div.style.opacity = "0";
    host.appendChild(div);
    const td = getComputedStyle(div.querySelector("td"));
    const th = getComputedStyle(div.querySelector("th"));
    const out = { tdW: td.borderTopWidth, tdStyle: td.borderTopStyle, thW: th.borderBottomWidth, collapse: getComputedStyle(div.querySelector("table")).borderCollapse };
    div.remove();
    return out;
  })()`);
  ok(
    "US4 message tables carry weak borders",
    border.collapse === "collapse" && border.tdW === "1px" && border.tdStyle === "solid" && border.thW === "1px",
    JSON.stringify(border),
  );

  // -- US5: model group collapse ---------------------------------------------------
  await evalJs(`document.querySelector('[data-testid="model-chip"]').click()`);
  let pop = false;
  for (let i = 0; i < 10 && !pop; i++) {
    await sleep(200);
    pop = await evalJs(`!!document.querySelector('[data-testid="model-popover"]')`);
  }
  if (!pop) {
    ok("US5 group header folds and unfolds entries", false, "popover did not open");
  } else {
    const r = await evalJs(`(async () => {
      const group = document.querySelector('[data-testid="model-group"]');
      const options = () => document.querySelectorAll('[data-testid="model-option"]').length;
      const before = options();
      group.click();
      await new Promise((r) => setTimeout(r, 250));
      const collapsedAria = group.getAttribute("aria-expanded");
      const mid = options();
      group.click();
      await new Promise((r) => setTimeout(r, 250));
      const expandedAria = group.getAttribute("aria-expanded");
      const after = options();
      return { before, collapsedAria, mid, expandedAria, after };
    })()`);
    ok(
      "US5 group header folds and unfolds entries",
      r.collapsedAria === "false" && r.expandedAria === "true" && r.mid < r.before && r.after === r.before,
      `options ${r.before}→${r.mid}→${r.after}`,
    );
    await evalJs(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  }

  // -- US6: packages update-all button (present, NOT clicked) ----------------------
  await evalJs(`document.querySelector('[data-testid="tab-manage"]').click()`);
  await sleep(300);
  await evalJs(`document.querySelector('[data-testid="manage-tab-packages"]').click()`);
  let panel = false;
  for (let i = 0; i < 20 && !panel; i++) {
    await sleep(250);
    panel = await evalJs(`!!document.querySelector('[data-testid="packages-panel"]')`);
  }
  const btnState = panel
    ? await evalJs(`(() => {
        const b = document.querySelector('[data-testid="packages-update-all"]');
        return b ? { present: true, enabled: !b.disabled } : { present: false };
      })()`)
    : { present: false };
  ok("US6 update-all button present in the packages panel", btnState.present, btnState.enabled ? "enabled (rows present)" : btnState.present ? "disabled (no rows)" : "missing");

  // -- real-model round trip (optional) ------------------------------------------
  if (REAL_MODEL) {
    await evalJs(`document.querySelector('[data-testid="tab-chat"]')?.click()`);
    await sleep(300);
    const errorsBefore = await evalJs(`document.querySelectorAll(".item-error").length`);
    await evalJs(`(() => {
      const ta = document.querySelector('[data-testid="composer-input"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "Reply with exactly: REAL_PI_OK");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('[data-testid="send-btn"]').click();
    })()`);
    let replied = false;
    for (let i = 0; i < 90 && !replied; i++) {
      await sleep(2000);
      replied = await evalJs(`document.body.innerText.includes("REAL_PI_OK")`);
    }
    ok("real-model round trip through the new send path", replied, replied ? "REAL_PI_OK arrived" : "no reply in 3 min");
    const errorsAfter = await evalJs(`document.querySelectorAll(".item-error").length`);
    ok("no new error items after the send", errorsAfter <= errorsBefore, `${errorsBefore}→${errorsAfter}`);
  }

  // Clear the leftover draft so the morning window starts clean (cosmetic —
  // never fail the smoke over it).
  try {
    await evalJs(`(() => {
      const ta = document.querySelector('[data-testid="composer-input"]');
      if (!ta) return "no-input";
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      if (!setter) return "no-setter";
      setter.call(ta, "");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return "cleared";
    })()`);
  } catch (e) {
    console.log(`(draft clear skipped: ${e.message})`);
  }

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("../build/smoke-018.png", import.meta.url), Buffer.from(shot.data, "base64"));
  console.log("✓ screenshot: build/smoke-018.png");

  const failed = results.filter((r) => !r.pass);
  console.log(failed.length === 0 ? "SMOKE-018 PASS" : `SMOKE-018 FAIL (${failed.length} failed)`);
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  fail(error.message);
}
