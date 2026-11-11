// Read-only JCEF probe for spec 022: measure wheel scrolling in the *real*
// webview instead of a mock page.
//
// Preconditions:
//   1. IDE launched with the JCEF debug port (default 9222) — see
//      ../build/e2e-jcef/webstorm-e2e.vmoptions and `-Dpi.agent.autoOpen=true`
//   2. the pi tool window is open (the JCEF browser only exists after that)
//
// Usage: node probe-scroll-jcef.mjs [port] [sessionRowIndex]
// Writes probe-scroll-jcef.json next to this file and prints a summary.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || process.env.JCEF_PORT || "9222";
// Optional row index override; by default the session with the most messages
// is used (see the picker below — row order changes as sessions come and go).
const FORCED_ROW = process.argv[3] != null ? Number(process.argv[3]) : null;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "probe-scroll-jcef.json");
const STEP_PX = 120; // one wheel notch
const STEPS = 10; // -> 1200px, what the user calls "scroll up"

const result = { port: PORT, at: new Date().toISOString(), page: null, checks: [], error: null };
const log = (...a) => console.log(...a);

function note(name, ok, detail) {
  result.checks.push({ name, ok, detail });
  log(`${ok === true ? "PASS" : ok === false ? "FAIL" : "INFO"}  ${name} :: ${JSON.stringify(detail)}`);
}

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  const pages = browser.contexts()[0].pages();
  log(`CDP attached, ${pages.length} page(s)`);

  // Claim the pi webview by DOM contract — JCEF URLs carry no stable marker.
  let page = null;
  for (const p of pages) {
    const hit = await p
      .evaluate(() => !!document.querySelector('[data-testid="message-list"],[data-testid="composer-input"],[data-testid="setup-card"]'))
      .catch(() => false);
    log(`  page ${p.url().slice(0, 90)} pi=${hit}`);
    if (hit) page = p;
  }
  if (!page) throw new Error("no pi webview among CDP pages");
  result.page = page.url();

  // Which build is actually loaded?
  const assets = await page.evaluate(() =>
    [...document.querySelectorAll("script[src],link[rel=stylesheet]")].map((e) => (e.src || e.href).split("/").pop()).filter(Boolean),
  );
  note("loaded assets", null, assets);

  // Open a long historical session so the transcript overflows.
  await page.getByTestId("tab-sessions").click();
  await page.waitForTimeout(1000);
  const rows = page.locator('[data-testid="session-row"]');
  const rowCount = await rows.count();
  if (rowCount === 0) throw new Error("sessions list is empty");

  // Session order shifts whenever the user adds or removes one, so the row
  // index must not be hard-coded (it used to point at "the 131-message
  // session" and silently waited forever once the list changed). Pick by
  // message count: the wheel probe needs the longest transcript on the machine.
  const rowInfo = await rows.evaluateAll((els) =>
    els.map((el, i) => {
      const text = el.innerText || "";
      const m = text.match(/(\d+)\s*(?:条消息|msgs?)/i);
      return { i, count: m ? Number(m[1]) : 0, text: text.replace(/\n+/g, " | ").slice(0, 90) };
    }),
  );
  const longest = rowInfo.reduce((best, cur) => (cur.count > best.count ? cur : best), rowInfo[0]);
  const chosen = FORCED_ROW != null ? rowInfo[FORCED_ROW] ?? longest : longest;
  if (!chosen) throw new Error(`sessions list has ${rowCount} rows, wanted index ${FORCED_ROW}`);
  note("picked session", null, chosen);
  await rows.nth(chosen.i).click();
  // Any rendered transcript will do — the probe judges against each list's own
  // reachable overflow, so item count is not the gate (43-entry sessions render
  // ~25 items; tool results are not items of their own).
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="item-"]').length > 10, null, { timeout: 90_000 });
  await page.waitForTimeout(1200); // let the first paint settle

  const env = await page.evaluate(() => {
    const q = (s) => !!document.querySelector(s);
    return {
      hasComposer: q('[data-testid="composer-input"]'),
      hasSetup: q('[data-testid="setup-card"]'),
      hasEmpty: q('[data-testid="empty-state"]'),
      items: document.querySelectorAll('[data-testid^="item-"]').length,
      itemBodies: document.querySelectorAll(".item-body").length,
    };
  });
  note("webview environment", null, env);

  // The declaration 022 added and we just removed.
  const cv = await page.evaluate(() => {
    const body = document.querySelector(".item-body");
    if (!body) return { present: false };
    const cs = getComputedStyle(body);
    return { present: true, contentVisibility: cs.contentVisibility, containIntrinsicSize: cs.containIntrinsicSize };
  });
  note("`.item-body` must be content-visibility: visible", cv.present && cv.contentVisibility === "visible", cv);

  const readTop = (sel) => page.evaluate((s) => document.querySelector(s).scrollTop, sel);

  async function wheelProbe(sel, label) {
    const meta = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      el.scrollTop = el.scrollHeight;
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflow: el.scrollHeight - el.clientHeight,
      };
    }, sel);
    if (!meta) return note(`${label}: wheel probe`, false, { error: "element not found", sel });
    if (meta.overflow < STEP_PX * 3) return note(`${label}: wheel probe`, null, { skipped: "not enough overflow", sel, ...meta });

    await page.waitForTimeout(400); // let the "scrolled to bottom" layout settle
    const box = await page.locator(sel).first().boundingBox();
    if (!box) return note(`${label}: wheel probe`, false, { error: "not visible", sel });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    // (a) fast consecutive notches — what a user actually does
    const start = await readTop(sel);
    for (let i = 0; i < STEPS; i++) await page.mouse.wheel(0, -STEP_PX);
    await page.waitForTimeout(400);
    const afterFast = await readTop(sel);
    const expected = -STEP_PX * STEPS;
    // A short list cannot move further than its own overflow — that is physics,
    // not a regression. Judge against the reachable distance.
    const reachable = Math.max(expected, -meta.overflow);
    note(`${label}: ${STEPS} fast notches go up`, afterFast - start <= reachable * 0.8, {
      sel,
      expected: reachable,
      actual: afterFast - start,
      from: start,
      to: afterFast,
      overflow: meta.overflow,
    });

    // (b) one notch at a time, layout settles in between
    await page.evaluate((s) => {
      const el = document.querySelector(s);
      el.scrollTop = el.scrollHeight;
    }, sel);
    await page.waitForTimeout(400);
    const perStep = [];
    for (let i = 0; i < STEPS; i++) {
      await page.mouse.wheel(0, -STEP_PX);
      await page.waitForTimeout(150);
      perStep.push(await readTop(sel));
    }
    const monotonic = perStep.every((v, i) => i === 0 || v <= perStep[i - 1] + 1);
    note(`${label}: step-by-step never moves down`, monotonic, { perStep, net: perStep[perStep.length - 1] - perStep[0] });
  }

  await wheelProbe('[data-testid="message-list"]', "message list");

  // sessions list (21 rows here — may or may not overflow)
  await page.getByTestId("tab-sessions").click();
  await page.waitForTimeout(1000);
  const scrollables = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sessions-view"], [data-testid="sessions-view"] *')]
      .filter((el) => el.scrollHeight - el.clientHeight > 40)
      .slice(0, 4)
      .map((el) => ({ cls: el.className, h: el.scrollHeight, ch: el.clientHeight })),
  );
  note("sessions list scrollable containers", null, scrollables);
  const sessionsSel = scrollables.length ? ".sessions-list" : '[data-testid="sessions-view"]';
  await wheelProbe(sessionsSel, "sessions list");
  await page.getByTestId("tab-chat").click();
  await page.waitForTimeout(600);

  // model picker
  const chip = page.locator('[data-testid="model-chip"]');
  if (await chip.count()) {
    await chip.first().click();
    await page.waitForTimeout(900);
    if (await page.locator('[data-testid="model-popover"]').count()) {
      // The popover itself may not be the scroller — find the real one.
      const inner = await page.evaluate(() => {
        const pop = document.querySelector('[data-testid="model-popover"]');
        const cands = [pop, ...pop.querySelectorAll("*")].filter((el) => el.scrollHeight - el.clientHeight > 20);
        return cands.slice(0, 3).map((el) => ({ cls: String(el.className).slice(0, 40), h: el.scrollHeight, ch: el.clientHeight }));
      });
      note("model picker scrollable containers", null, inner);
      if (inner.length) {
        await wheelProbe(`.${inner[0].cls.split(" ")[0]}`, "model picker");
      } else {
        note("model picker: wheel probe", null, { skipped: "model list does not overflow in this profile" });
      }
      await page.keyboard.press("Escape");
    } else {
      note("model picker: wheel probe", null, { skipped: "popover did not open" });
    }
  } else {
    note("model picker: wheel probe", null, { skipped: "no model-chip" });
  }
} catch (err) {
  result.error = String(err?.stack ?? err);
  log("ERROR", result.error);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
  const failed = result.checks.filter((c) => c.ok === false).length;
  log(`\nwritten ${OUT}`);
  log(`SUMMARY: ${result.checks.length - failed} ok, ${failed} failed`);
  process.exitCode = result.error || failed ? 1 : 0;
}
