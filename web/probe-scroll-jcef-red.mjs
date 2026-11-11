// RED verification for spec 022, on the live JCEF page.
//
// Same webview, same 131-message session, same wheel notches. The only
// variable is the `content-visibility` declaration on `.item-body`.
//
// It cannot be injected at runtime: `contain-intrinsic-size: auto` remembers
// whatever size an element already had, so a late <style> tag never recreates
// the "never rendered, placeholder only" state. The declaration therefore has
// to be present *before the document loads*, which means a CDP
// Page.addScriptToEvaluateOnNewDocument round trip.
//
// Usage: node probe-scroll-jcef-red.mjs [port] [sessionRowIndex]
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || "9222";
const ROW = Number(process.argv[3] ?? 4);
const OUT = join(dirname(fileURLToPath(import.meta.url)), "probe-scroll-jcef-red.json");
const STEP = 120;
const NOTCHES = 10;
const LIST = '[data-testid="message-list"]';
const STYLE_ID = "__cv_red_probe";

const log = (...a) => console.log(...a);
const report = { port: PORT, at: new Date().toISOString(), runs: [], error: null };

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
const page = browser.contexts()[0].pages().find(() => true);
if (!page) throw new Error("no CDP page");
const cdp = await page.context().newCDPSession(page);

const top = () => page.evaluate((s) => document.querySelector(s).scrollTop, LIST);

async function openLongSession() {
  await page.getByTestId("tab-sessions").click();
  await page.waitForTimeout(1200);
  const rows = page.locator('[data-testid="session-row"]');
  if ((await rows.count()) <= ROW) throw new Error("session row missing after reload");
  await rows.nth(ROW).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="item-"]').length > 40, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);
}

/** How tall does the browser think each body is? With `content-visibility: auto`
 *  the skipped ones report their placeholder, not their content. */
const heights = () =>
  page.evaluate(() => {
    const hs = [...document.querySelectorAll(".item-body")].map((el) => Math.round(el.getBoundingClientRect().height));
    if (!hs.length) return null;
    const buckets = { tiny: 0, placeholder: 0, real: 0 };
    for (const h of hs) {
      if (h < 5) buckets.tiny++;
      else if (h < 200) buckets.placeholder++;
      else buckets.real++;
    }
    return { total: hs.length, ...buckets, min: Math.min(...hs), max: Math.max(...hs) };
  });

/** Fresh-load state: transcript at the bottom, everything above never rendered. */
async function measure(label) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    el.scrollTop = el.scrollHeight;
  }, LIST);
  await page.waitForTimeout(800);

  const facts = await page.evaluate(() => {
    const el = document.querySelector(".item-body");
    const list = document.querySelector('[data-testid="message-list"]');
    return {
      cv: el ? getComputedStyle(el).contentVisibility : "missing",
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      items: document.querySelectorAll('[data-testid^="item-"]').length,
    };
  });
  facts.bodies = await heights();

  const box = await page.locator(LIST).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const from = await top();
  for (let i = 0; i < NOTCHES; i++) await page.mouse.wheel(0, -STEP);
  await page.waitForTimeout(600);
  const to = await top();

  const delta = to - from;
  const row = { label, ...facts, from, to, delta, expected: -STEP * NOTCHES, ok: delta <= -STEP * NOTCHES * 0.8 };
  report.runs.push(row);
  log(`${row.ok ? "PASS" : "FAIL"}  ${label}`);
  log(`      cv=${facts.cv} items=${facts.items} scrollHeight=${facts.scrollHeight} bodies=${JSON.stringify(facts.bodies)}`);
  log(`      ${from} -> ${to} (delta ${delta}, expected ${row.expected})`);
  return row;
}

const CV_SOURCE = `(() => {
  const inject = () => {
    if (document.getElementById(${JSON.stringify(STYLE_ID)})) return;
    const st = document.createElement('style');
    st.id = ${JSON.stringify(STYLE_ID)};
    st.textContent = '.item-body { content-visibility: auto; contain-intrinsic-size: auto 120px; }';
    (document.head || document.documentElement).appendChild(st);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();`;

try {
  // --- A: the shipped build -------------------------------------------------
  // A previous run may have left an `addScriptToEvaluateOnNewDocument` behind
  // (CEF does not always drop it when the CDP client disconnects), in which
  // case A would silently measure the *injected* variant. Check, don't assume.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2500);
  await openLongSession();
  const a = await measure("A: shipped build (content-visibility: visible)");
  if (a.cv !== "visible") {
    log("WARNING: A was measured with content-visibility already injected — restart the IDE before trusting run A.");
  }

  // --- B: declaration present before the document loads ---------------------
  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CV_SOURCE });
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2500);
  await openLongSession();
  const b = await measure("B: content-visibility present at load");

  // --- C: same page with the injection removed ------------------------------
  await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2500);
  await openLongSession();
  const c = await measure("C: declaration removed again");

  report.verdict = {
    heightRatio: +(b.scrollHeight / c.scrollHeight).toFixed(3),
    deltaA: report.runs[0]?.delta,
    deltaB: b.delta,
    deltaC: c.delta,
  };
  log(`\nverdict ${JSON.stringify(report.verdict)}`);
} catch (err) {
  report.error = String(err?.stack ?? err);
  log("ERROR", report.error);
} finally {
  await browser.close().catch(() => undefined);
  writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  log(`written ${OUT}`);
  process.exitCode = report.error ? 1 : 0;
}
