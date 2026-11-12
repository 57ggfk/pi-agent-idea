#!/usr/bin/env node
/**
 * probe-switch-race.mjs — real-machine probe for "rapid session switching fails".
 *
 * Reported behaviour: switch to a session, and while it is still loading switch
 * to another one; the app flashes 「切换会话失败」.
 *
 * This runs against the *real* WebStorm + real pi process + real session files
 * (CDP is only used to drive clicks and read the DOM). It replays the user's
 * gesture — tap a row, tap the sessions tab again, tap the next row — at a
 * configurable gap, then reports:
 *
 *   - whether 「切换会话失败」 ever appeared in the transcript
 *   - the `[pi-agent] perf switch.*` timeline (pending / ready / failed + reason)
 *   - where the app ended up (tab, title, item count)
 *
 * Usage: node probe-switch-race.mjs [port] [gapMs] [taps]
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const PORT = Number(process.argv[2] || 9222);
const GAP = Number(process.argv[3] || 400);
const TAPS = Number(process.argv[4] || 3);
const OUT = process.env.PROBE_OUT || "probe-switch-race.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = { at: new Date().toISOString(), port: PORT, gap: GAP, taps: TAPS, steps: [], perf: [], errors: [] };

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("127.0.0.1"));
  if (!page) throw new Error("no pi webview among CDP pages");
  result.page = page.url().replace(/([?&]token=)[^&#]*/gi, "$1<redacted>");

  // Every performance mark the store emits lands here. These are the only
  // ground truth for "did the switch actually succeed, and how long did it take".
  const perf = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("perf switch.") || t.includes("perf new_session")) perf.push({ t: Date.now(), text: t });
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="tabs"]', { timeout: 60_000 });
  await page.waitForTimeout(1_500);

  const rows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="session-row"]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.innerText.replace(/\n/g, " | ").trim(), y: r.y + r.height / 2, visible: r.y >= 0 && r.y < innerHeight };
      }),
    );

  const onSessions = () => page.evaluate(() => !!document.querySelector('[data-testid="session-row"]'));
  const errorText = () =>
    page.evaluate(() => {
      const t = document.body.innerText;
      const i = t.indexOf("切换会话失败");
      return i >= 0 ? t.slice(i, i + 90).replace(/\n/g, " ") : null;
    });

  // ---- pick targets: distinct sessions, longest first so the first switch
  // has real work to do and the later taps genuinely overlap it. --------------
  await page.getByTestId("tab-sessions").click();
  await page.waitForSelector('[data-testid="session-row"]', { timeout: 20_000 });
  await page.waitForTimeout(600);
  const all = await rows();
  result.rows = all.length;
  // Stay well inside the viewport: a click below it lands on nothing and the
  // tap quietly does not happen, which looks like "no race" for the wrong reason.
  const withCount = all
    .map((r, i) => ({ ...r, i, n: Number((r.text.match(/(\d+)\s*条消息/) || [])[1] || 0) }))
    .filter((r) => r.visible && r.y > 40 && r.y < 700);
  const targets = withCount.sort((a, b) => b.n - a.n).slice(0, TAPS);
  result.targets = targets.map((t) => ({ text: t.text.slice(0, 50), messages: t.n }));
  if (targets.length < 2) throw new Error(`need >=2 visible sessions, got ${targets.length}`);

  // Re-resolve a row by its text right before clicking: the list re-sorts and
  // re-renders after every switch, so a cached index is meaningless.
  const tap = async (needle) => {
    const hit = await page.evaluate((n) => {
      const el = [...document.querySelectorAll('[data-testid="session-row"]')].find((e) => e.innerText.replace(/\n/g, " | ").includes(n));
      if (!el) return { reason: "row vanished" };
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      // What would actually receive the click, and is that row the one we asked
      // for? A silent miss looks identical to "the app ignored a fast tap".
      const at = document.elementFromPoint(x, y);
      const owner = at && at.closest('[data-testid="session-row"]');
      return {
        x,
        y,
        hitTag: at ? `${at.tagName}.${String(at.className).slice(0, 40)}` : "none",
        hitRow: owner ? owner.innerText.replace(/\n/g, " | ").slice(0, 40) : null,
        wantsThisRow: !!owner && owner === el,
      };
    }, needle);
    if (hit.x === undefined) return { tapped: false, ...hit };
    await page.mouse.click(hit.x, hit.y);
    return { tapped: true, at: { x: Math.round(hit.x), y: Math.round(hit.y) }, hit: { tag: hit.hitTag, row: hit.hitRow, exact: hit.wantsThisRow } };
  };

  // ---- replay the gesture --------------------------------------------------
  for (let k = 0; k < targets.length; k++) {
    const t0 = Date.now();
    if (!(await onSessions())) {
      await page.getByTestId("tab-sessions").click();
      await page.waitForSelector('[data-testid="session-row"]', { timeout: 15_000 });
      result.steps.push({ k, action: "back-to-sessions", ms: Date.now() - t0 });
    }
    // Match on a distinctive slice of the title; the row's message count may
    // change while pi is mid-switch, the title is stable enough.
    const needle = targets[k].text.split(" | ")[0].slice(0, 12);
    const r = await tap(needle);
    result.steps.push({ k, target: needle, ...r, ms: Date.now() - t0 });
    const err = await errorText();
    if (err) result.errors.push({ afterTap: k, text: err });
    if (k < targets.length - 1) await sleep(GAP);
  }

  // ---- settle: 026's deadline is 5s per switch, allow two of them ----------
  await page.waitForTimeout(12_000);
  result.settled = await page.evaluate(() => ({
    tab: document.querySelector('[data-testid="session-row"]') ? "sessions" : "chat",
    items: document.querySelectorAll('[data-testid^="item-"]').length,
    pending: !!document.querySelector('[data-testid="switch-pending"], .switch-pending'),
    title: (document.querySelector(".session-title, [data-testid=\"chat-title\"]")?.textContent || "").trim().slice(0, 60),
  }));
  const finalErr = await errorText();
  if (finalErr && !result.errors.some((e) => e.text === finalErr)) result.errors.push({ afterTap: "settle", text: finalErr });

  result.perf = perf.map((p) => ({ t: p.t - perf[0].t, text: p.text.slice(0, 160) }));
  result.errorCount = await page.evaluate(() =>
    [...document.querySelectorAll(".item, [data-testid^=\"item-\"]")].filter((e) => e.innerText.includes("切换会话失败")).length,
  );

  // ---- verdict --------------------------------------------------------------
  const failures = result.perf.filter((p) => p.text.includes("switch.failed"));
  // Overlap is the whole point: a switch that starts before the previous one
  // reports ready is the condition the user describes ("还在加载就点了下一个").
  // Without an overlap the run proves nothing, so it is reported explicitly
  // instead of being counted as a clean pass.
  let open = -1;
  let overlaps = 0;
  for (const p of result.perf) {
    if (p.text.includes("switch.pending")) {
      if (open >= 0) overlaps++;
      open = p.t;
    } else if (p.text.includes("switch.ready") || p.text.includes("switch.failed")) {
      open = -1;
    }
  }
  result.overlaps = overlaps;
  result.checks = [
    { name: "连切过程中/之后没有出现「切换会话失败」", ok: result.errors.length === 0, detail: result.errors },
    { name: "没有 switch.failed 埋点", ok: failures.length === 0, detail: failures.map((f) => f.text) },
    { name: "至少一次切换与前一次重叠（复现条件成立）", ok: overlaps > 0, detail: { overlaps, switches: result.perf.filter((p) => p.text.includes("pending")).length } },
    { name: "最终停在最后一次点击的会话", ok: result.settled.tab === "chat" && result.settled.items > 0, detail: result.settled },
    { name: "有内容读出（不是空白页）", ok: result.settled.items > 0, detail: { items: result.settled.items } },
  ];
  for (const c of result.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  ${c.ok ? "" : JSON.stringify(c.detail).slice(0, 300)}`);
  console.log("perf:");
  for (const p of result.perf) console.log(`  +${String(p.t).padStart(6)}ms  ${p.text}`);
  console.log(`settled: ${JSON.stringify(result.settled)}`);
} catch (e) {
  result.error = String(e && e.stack ? e.stack : e).slice(0, 1200);
  console.log("ERROR", result.error);
} finally {
  writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
  console.log(`verdict -> ${OUT}`);
  if (browser) await browser.close().catch(() => {});
}
