/**
 * 033 real-machine probe, raw-CDP edition.
 *
 * playwright's connectOverCDP sends browser-level calls (setDownloadBehavior)
 * that the older JCEF inside the runIde 2024.3.1 sandbox rejects, so this
 * probe talks to the *page* target directly over the DevTools WebSocket that
 * Node 25 ships natively. Everything is one Runtime.evaluate per step.
 *
 * Prerequisite:
 *   PI_IDE_E2E=real PI_IDE_E2E_PROJECT=<repo>/test/e2e-project \
 *   PI_CODING_AGENT_DIR=<sandbox with one npm package installed> \
 *   ./gradlew runIde
 *
 * Usage: node scripts/probe-033-cdp.mjs [--cdp http://127.0.0.1:9222]
 */
import { setTimeout as sleep } from "node:timers/promises";

const cdpArg = process.argv.indexOf("--cdp");
const CDP_HTTP = cdpArg > -1 ? process.argv[cdpArg + 1] : "http://127.0.0.1:9222";

const results = [];
function check(name, ok, detail = "") {
  results.push({ n: name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(message) {
  console.error(`PROBE-033 FAIL: ${message}`);
  process.exit(1);
}

const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const pages = targets.filter((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1"));
console.log(`page targets: ${pages.length} → ${pages.map((t) => t.title || t.url).join(" | ")}`);
// Prefer the plugin tool window's own page (token URL); a stale duplicate from
// an earlier probe run would answer every read with an empty document.
const page = pages.at(-1);
if (!page) fail("Pi Agent page target not found");
console.log(`attached to ${page.url}`);

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
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return res.result?.value;
}

/** Polls an expression until it returns truthy (or the budget runs out). */
async function waitFor(expression, timeoutMs = 20_000, everyMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(`Boolean(${expression})`);
    if (value) return true;
    await sleep(everyMs);
  }
  return false;
}

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;

/** Waits for the element, then dispatches a real click. */
async function click(sel, timeoutMs = 10_000) {
  if (!(await waitFor(`!!${q(sel)}`, timeoutMs))) throw new Error(`element never appeared: ${sel}`);
  await evaluate(`${q(sel)}.click()`);
}

try {
  // Clean slate: an earlier probe may have left the app mid-flow.
  await evaluate("location.reload()");
  await sleep(2_000);
  check(
    "UI booted",
    await waitFor(`${q('[data-testid="empty-state"]')} || ${q('[data-testid="composer-input"]')}`, 40_000),
  );

  await click('[data-testid="tab-manage"]');
  check(
    "manage tabs visible",
    await waitFor(`${q('[data-testid="manage-tab-packages"]')}`, 10_000),
  );
  await click('[data-testid="manage-tab-packages"]');

  // The sandbox holds exactly one npm package (openwiki pinned at 0.9.0):
  // the structured row must show the source line pi printed plus the version
  // read from package.json at the resolved path.
  check("real pi list parsed into a structured row", await waitFor(`${q('[data-testid="package-row"]')}`, 20_000));
  const rowText = (await evaluate(`${q('[data-testid="package-row"]')}?.textContent ?? ""`)) ?? "";
  check("row carries the pi source line", /openwiki/.test(rowText), rowText.replace(/\n/g, " | "));
  const version = (await evaluate(`${q('[data-testid="package-version-0"]')}?.textContent ?? ""`)) ?? "";
  check("version read from the resolved path", /0\.9\.0/.test(version), version);

  // Version check against the real registry (preflight + /latest).
  await click('[data-testid="package-check-0"]');
  check(
    "real registry version check",
    await waitFor(`${q('[data-testid="package-check-verdict-0"]')}`, 20_000),
  );
  const verdict = (await evaluate(`${q('[data-testid="package-check-verdict-0"]')}?.textContent ?? ""`)) ?? "";
  check("verdict is up-to-date (en/zh per IDE language)", /Up to date|已是最新/.test(verdict), verdict);
  const upgradeDisabled = await evaluate(
    `${q('[data-testid="package-upgrade-0"]')}?.disabled ?? true`,
  );
  check("upgrade disabled when up to date", upgradeDisabled === true, String(upgradeDisabled));

  // Market tab hits the real npm registry search through the Kotlin HTTP client.
  await click('[data-testid="packages-tab-market"]');
  check("real market search reached the npm registry", await waitFor(`${q('[data-testid="market-card"]')}`, 30_000));
  const cardCount = await evaluate(`document.querySelectorAll('[data-testid="market-card"]').length`);
  check("first page renders 50 cards", cardCount === 50, String(cardCount));
  const downloads = (await evaluate(`${q('[data-testid="market-downloads"]')}?.textContent ?? ""`)) ?? "";
  check("download count formatted", /\d{1,3}(,\d{3})+/.test(downloads), downloads);
  const pageInfo = (await evaluate(`${q('[data-testid="market-pageinfo"]')}?.textContent ?? ""`)) ?? "";
  check("pager computed from the live total", /^\d+\s*\/\s*\d+$/.test(pageInfo), pageInfo);

  // Registry preset row lives on the installed tab.
  await click('[data-testid="packages-tab-installed"]');
  check(
    "registry row present",
    await waitFor(`${q('[data-testid="package-registry-follow"]')}`, 10_000),
  );
  const followChecked = await evaluate(`${q('[data-testid="package-registry-follow"]')}?.checked ?? false`);
  check("follow npm preselected", followChecked === true, String(followChecked));
} catch (e) {
  fail(e.message);
}

const pass = results.filter((r) => r.ok).length;
console.log(`\nPROBE-033: ${pass}/${results.length} passed`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
