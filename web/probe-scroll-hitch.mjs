// Read-only JCEF probe: hunt for the *intermittent* hitch while scrolling a
// long transcript up, which `probe-scroll-jcef.mjs` cannot see by design.
//
// Why a second probe:
//   `probe-scroll-jcef.mjs` only asserts where the list landed after N notches.
//   The in-app `scroll.frame` mark (MessageList D7) takes its `startedAt`
//   *inside* the wheel handler, so a main-thread block that happens before the
//   handler runs is invisible to it — which is exactly the "stuck for a
//   moment" symptom. This probe measures from the outside instead:
//     - a rAF loop records every inter-frame gap (a block shows up as one long
//       gap, whenever it happens and whatever caused it);
//     - `long-animation-frame` (LoAF) attribution says whether the time went
//       to script, style/layout or rendering;
//     - every frame also carries `scrollTop`, so a hitch can be placed on the
//       timeline (near the top? mid-list? unrelated to position?).
//
// Usage: node probe-scroll-hitch.mjs [port] [sweeps]
// Writes probe-scroll-hitch.json next to this file. Read-only: no messages
// are sent, nothing is forked, the transcript is left at the bottom.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || process.env.JCEF_PORT || "9222";
const SWEEPS = Number(process.argv[3] || 6);
const OUT = join(dirname(fileURLToPath(import.meta.url)), "probe-scroll-hitch.json");
const STEP_PX = 120;
const HITCH_MS = 50; // one dropped frame at 60Hz is 33ms; 50ms = the probe's own bar

const result = { port: PORT, at: new Date().toISOString(), page: null, env: null, sweeps: [], checks: [], error: null };
const log = (...a) => console.log(...a);
function note(name, ok, detail) {
  result.checks.push({ name, ok, detail });
  log(`${ok === true ? "PASS" : ok === false ? "FAIL" : "INFO"}  ${name} :: ${JSON.stringify(detail)}`);
}

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  const pages = browser.contexts()[0].pages();
  let page = null;
  for (const p of pages) {
    const hit = await p
      .evaluate(() => !!document.querySelector('[data-testid="message-list"],[data-testid="composer-input"],[data-testid="setup-card"],[data-testid="tabs"]'))
      .catch(() => false);
    if (hit) page = p;
  }
  if (!page) throw new Error("no pi webview among CDP pages");
  // Never persist the bridge session token (see probe-wheel-real.mjs).
  result.page = page.url().replace(/([?&]token=)[^&#]*/gi, "$1<redacted>");

  // ---- open the longest transcript -------------------------------------
  if (await page.getByTestId("tab-sessions").count()) {
    await page.getByTestId("tab-sessions").click();
    await page.waitForTimeout(800);
  }
  const rows = page.locator('[data-testid="session-row"]');
  if (!(await rows.count())) throw new Error("sessions list is empty");
  const rowInfo = await rows.evaluateAll((els) =>
    els.map((el, i) => {
      const m = (el.innerText || "").match(/(\d+)\s*(?:条消息|msgs?)/i);
      return { i, count: m ? Number(m[1]) : 0, text: (el.innerText || "").replace(/\n+/g, " | ").slice(0, 70) };
    }),
  );
  const longest = rowInfo.reduce((a, b) => (b.count > a.count ? b : a), rowInfo[0]);
  note("picked session", null, longest);
  await rows.nth(longest.i).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="item-"]').length > 10, null, { timeout: 90_000 });
  await page.waitForTimeout(1200);

  result.env = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]');
    const imgs = [...document.querySelectorAll("img")];
    const pres = [...document.querySelectorAll("pre")];
    return {
      items: document.querySelectorAll('[data-testid^="item-"]').length,
      scrollHeight: list?.scrollHeight ?? 0,
      clientHeight: list?.clientHeight ?? 0,
      imgs: imgs.length,
      imgDecoded: imgs.filter((e) => e.complete && e.naturalWidth > 0).length,
      pre: pres.length,
      preMaxChars: Math.max(0, ...pres.map((e) => e.textContent.length)),
      longAnimationFrame: typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame") === true,
      longtask: typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask") === true,
    };
  });
  note("transcript environment", null, result.env);

  // ---- instrumentation -------------------------------------------------
  await page.evaluate(() => {
    const w = window;
    w.__hitch = { frames: [], loaf: [], longtasks: [], running: false };
    const list = document.querySelector('[data-testid="message-list"]');

    const loop = () => {
      if (!w.__hitch.running) return;
      const now = performance.now();
      const last = w.__hitch.frames[w.__hitch.frames.length - 1];
      if (last) w.__hitch.frames.push({ t: Math.round(now), gap: Math.round(now - last.t), top: Math.round(list.scrollTop) });
      else w.__hitch.frames.push({ t: Math.round(now), gap: 0, top: Math.round(list.scrollTop) });
      requestAnimationFrame(loop);
    };
    const start = (kind) => {
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) {
            w.__hitch[kind].push({
              start: Math.round(e.startTime),
              dur: Math.round(e.duration),
              top: Math.round(list.scrollTop),
              scripts: (e.scripts ?? []).map((s) => ({
                dur: Math.round(s.duration),
                fn: s.sourceFunctionName || s.invoker || "",
                src: (s.sourceURL || "").split("/").pop(),
              })).slice(0, 4),
              styleLayout: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : null,
            });
          }
        }).observe({ type: kind === "loaf" ? "long-animation-frame" : "longtask", buffered: false });
      } catch (err) {
        w.__hitch[kind].push({ error: String(err) });
      }
    };
    start("loaf");
    start("longtasks");

    w.__hitch.begin = () => {
      w.__hitch.frames = [];
      w.__hitch.loaf = [];
      w.__hitch.longtasks = [];
      w.__hitch.running = true;
      requestAnimationFrame(loop);
    };
    w.__hitch.end = () => {
      w.__hitch.running = false;
      return { frames: w.__hitch.frames, loaf: w.__hitch.loaf, longtasks: w.__hitch.longtasks };
    };
    // Pre-warm image decoding so the first sweep is not measuring "the very
    // first paint ever" — the user's report is about repeat scrolling.
    [...document.querySelectorAll("img")].forEach((i) => {
      if (i.decode) i.decode().catch(() => undefined);
    });
  });

  const listHandle = page.locator('[data-testid="message-list"]');
  const box = await listHandle.boundingBox();
  if (!box) throw new Error("message-list has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // The CDP round-trip per notch is an IDE-side probe: with in-process JCEF
  // (`ide.browser.jcef.out-of-process.enabled=false`) an IDE stall delays the
  // injected input too, so a 300ms notch is a 300ms freeze the user sees —
  // even though the renderer's own frames look fine.
  async function wheelRt(dy) {
    const t0 = Date.now();
    await page.mouse.wheel(0, dy);
    return Date.now() - t0;
  }

  // ---- sweeps ----------------------------------------------------------
  for (let s = 0; s < SWEEPS; s++) {
    // The last sweep mimics the user's actual path: switch away and back, then
    // scroll up *before* anything settles — freshly laid-out content above the
    // viewport has never been painted, which is where a one-off hitch lives.
    const cold = s === SWEEPS - 1;
    if (cold) {
      await page.getByTestId("tab-sessions").click();
      await page.waitForTimeout(500);
      const others = page.locator('[data-testid="session-row"]');
      if ((await others.count()) > 1) {
        const otherIdx = longest.i === 0 ? 1 : 0;
        await others.nth(otherIdx).click();
        await page.waitForTimeout(1500);
        await page.getByTestId("tab-sessions").click();
        await page.waitForTimeout(500);
        await others.nth(longest.i).click();
        await page.waitForFunction(() => document.querySelectorAll('[data-testid^="item-"]').length > 10, null, { timeout: 90_000 });
        await page.waitForTimeout(250); // no long settle: this is "just opened"
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      }
    }

    // Park at the bottom, let everything settle, then scroll up in one motion.
    // (The cold sweep skips the settle on purpose.)
    const geo = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="message-list"]');
      el.scrollTop = el.scrollHeight;
      return { top: el.scrollTop, height: el.scrollHeight };
    });
    await page.waitForTimeout(cold ? 0 : 600);

    await page.evaluate(() => window.__hitch.begin());
    const t0 = Date.now();
    let steps = 0;
    const rts = [];
    for (; steps < 400; steps++) {
      rts.push(await wheelRt(-STEP_PX));
      // Real wheel input arrives as a stream; 16ms keeps the burst inside the
      // frame budget so a hitch is the list's fault, not the probe's.
      await page.waitForTimeout(cold ? 8 : 16);
      const top = await page.evaluate(() => document.querySelector('[data-testid="message-list"]').scrollTop);
      if (top <= 0) break;
    }
    await page.waitForTimeout(350);
    const data = await page.evaluate(() => window.__hitch.end());
    const wall = Date.now() - t0;

    const gaps = data.frames.filter((f) => f.gap >= HITCH_MS);
    const maxGap = data.frames.reduce((m, f) => Math.max(m, f.gap), 0);
    const atTop = gaps.filter((f) => f.top <= STEP_PX * 2);
    const rtSorted = [...rts].sort((a, b) => a - b);
    const rt = {
      p50: rtSorted[Math.floor(rtSorted.length / 2)],
      p95: rtSorted[Math.floor(rtSorted.length * 0.95)],
      max: rtSorted[rtSorted.length - 1],
      slow: rts.filter((v) => v >= 100).length,
    };
    const sweep = {
      sweep: s,
      cold,
      wallMs: wall,
      steps,
      wheelRt: rt,
      reachedTop: (await page.evaluate(() => document.querySelector('[data-testid="message-list"]').scrollTop)) <= 0,
      fromTop: geo.top,
      frames: data.frames.length,
      maxGap,
      hitchCount: gaps.length,
      hitches: gaps.map((f) => ({ gap: f.gap, top: f.top })),
      hitchesNearTop: atTop.length,
      loaf: data.loaf.slice(0, 12),
      longtasks: data.longtasks.filter((x) => !x.error).slice(0, 12),
      observerErrors: [...data.loaf, ...data.longtasks].filter((x) => x.error).slice(0, 2),
    };
    result.sweeps.push(sweep);
    log(
      `sweep ${s}${cold ? " (cold)" : ""}: ${steps} notches / ${wall}ms, frames=${sweep.frames}, maxGap=${maxGap}ms, ` +
        `inputRt p50=${rt.p50} p95=${rt.p95} max=${rt.max}ms${rt.slow ? ` slow=${rt.slow}` : ""}, ` +
        `hitches(>=${HITCH_MS}ms)=${sweep.hitchCount}${atTop.length ? ` (${atTop.length} near top)` : ""}` +
        (sweep.hitches.length ? ` at ${JSON.stringify(sweep.hitches.slice(0, 6))}` : ""),
    );
  }

  // ---- verdict ---------------------------------------------------------
  const allHitches = result.sweeps.flatMap((s) => s.hitches);
  const nearTop = result.sweeps.reduce((n, s) => n + s.hitchesNearTop, 0);
  const worst = allHitches.reduce((m, h) => Math.max(m, h.gap), 0);
  note("每轮都能滑到顶", result.sweeps.every((s) => s.reachedTop), result.sweeps.map((s) => s.reachedTop));
  note("无 >=50ms 掉帧", allHitches.length === 0, { sweeps: result.sweeps.length, hitches: allHitches.length, worst });
  note("停顿不集中在顶部", nearTop === 0, { hitchesNearTop: nearTop, total: allHitches.length });

  // Where the time went, when there was any.
  const attribution = result.sweeps.flatMap((s) => s.loaf.map((l) => ({ ...l, sweep: s.sweep })));
  if (attribution.length) note("LoAF 归因样本", null, attribution.slice(0, 8));
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
