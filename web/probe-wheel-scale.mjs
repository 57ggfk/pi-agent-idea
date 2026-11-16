// Wheel sensitivity probe: how many CSS pixels does ONE real notch move?
//
// The user's report is "scrolling feels slower than the IDE editor". Two very
// different root causes produce that feeling and they need opposite fixes:
//   a) the notch is *mapped to fewer pixels* than a browser notch (120px) —
//      fix = scale the delta;
//   b) the notch moves the right distance but over a long animation — fix =
//      shorten/take over the curve, scaling alone would make it worse.
// So this measures both: the displacement AND the settle curve at 16/33/66/
// 100/200/400ms after a single real notch.
//
// Why the real wheel (win_wheel.py): CDP's Input.dispatchMouseEvent injects
// pixel-precise deltas and never enters Chromium's notch->animation path, so a
// CDP-only probe cannot see (b) at all.
//
// Preconditions: IDE with -Dide.browser.jcef.debug.port=9222, Pi Agent tool
// window open and visible.
//
// Usage: node probe-wheel-scale.mjs [port] [--fix=scale:<factor>]
// Writes build/probe-wheel-scale.json
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || process.env.JCEF_PORT || "9222";
const FIXARG = process.argv.find((a) => a.startsWith("--fix="));
const FIX = FIXARG ? FIXARG.slice(6) : "none";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUTDIR = join(ROOT, "build");
mkdirSync(OUTDIR, { recursive: true });
const OUT = join(OUTDIR, `probe-wheel-scale-${FIX.replace(/[:/]/g, "_")}.json`);
const PY = "python";
const NOTCH = 120; // WM_MOUSEWHEEL delta, i.e. one detent
const SAMPLES = 5;

const result = { port: PORT, at: new Date().toISOString(), fix: FIX, env: null, calib: null,
                 samples: [], settle: [], checks: [], error: null };
const log = (...a) => console.log(...a);
function note(name, ok, detail) {
  result.checks.push({ name, ok, detail });
  log(`${ok === true ? "PASS" : ok === false ? "FAIL" : "INFO"}  ${name} :: ${JSON.stringify(detail)}`);
}
const py = (...args) =>
  JSON.parse(
    execFileSync(PY, [join(HERE, "win_wheel.py"), ...args.map(String)], { encoding: "utf8" })
      .trim().split("\n").pop(),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  let page = null;
  for (const p of browser.contexts()[0].pages()) {
    const hit = await p
      .evaluate(() => !!document.querySelector('[data-testid="message-list"],[data-testid="composer-input"],[data-testid="tabs"]'))
      .catch(() => false);
    if (hit) page = p;
  }
  if (!page) throw new Error("no pi webview among CDP pages");

  // The page outlives the probe, and a listener left behind by a *previous*
  // run (with a different --fix) cannot be named any more — it stacked its
  // delta on top of the current one and made a clean baseline impossible.
  // Only a fresh document guarantees one.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="tabs"], [data-testid="composer-input"]', { timeout: 60_000 });
  await page.waitForTimeout(1200);

  // A transcript is required: an empty session has nothing to scroll.
  const items = () => page.evaluate(() => document.querySelectorAll('[data-testid^="item-"]').length);
  if ((await items()) < 10) {
    await page.getByTestId("tab-sessions").click().catch(() => undefined);
    await page.waitForTimeout(900);
    const rows = page.locator('[data-testid="session-row"]');
    const n = await rows.count();
    if (!n) throw new Error("sessions list is empty — open a session with messages first");
    const info = await rows.evaluateAll((els) =>
      els.map((el, i) => {
        const m = (el.innerText || "").match(/(\d+)\s*(?:条消息|msgs?)/i);
        return { i, count: m ? Number(m[1]) : 0 };
      }),
    );
    const longest = info.reduce((a, b) => (b.count > a.count ? b : a), info[0]);
    note("picked session", null, longest);
    await rows.nth(longest.i).click();
    await page.getByTestId("tab-chat").click().catch(() => undefined);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="item-"]').length > 10, null, { timeout: 90_000 });
    await page.waitForTimeout(1200);
  }

  result.env = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]');
    const cs = list ? getComputedStyle(list) : null;
    return {
      innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio,
      items: document.querySelectorAll('[data-testid^="item-"]').length,
      scrollHeight: list?.scrollHeight ?? 0, clientHeight: list?.clientHeight ?? 0,
      lineHeight: cs?.lineHeight ?? null, fontSize: cs?.fontSize ?? null,
      scrollBehavior: cs?.scrollBehavior ?? null,
      overscrollY: cs?.overscrollBehaviorY ?? null,
      // Chromium's own notch->pixel default, for the ratio.
      chromiumNotchPx: 100,
    };
  });
  note("transcript environment", null, result.env);

  // ---- instrumentation (idempotent: the page outlives the probe) -----------
  await page.evaluate(() => {
    if (window.__scaleCleanup) window.__scaleCleanup();
    const w = window;
    w.__wm = { t: 0, x: 0, y: 0 };
    w.__ws = { wheel: [] };
    const onMove = (e) => { w.__wm.t = Date.now(); w.__wm.x = e.clientX; w.__wm.y = e.clientY; };
    const onWheel = (e) => w.__ws.wheel.push({ dy: e.deltaY, mode: e.deltaMode });
    // The settle curve. This listener is registered BEFORE any injected fix so
    // it sees the pre-jump scrollTop: a takeover applies its delta inside its
    // own wheel listener, and a sampler registered later would record a flat
    // zero line and call an instant jump "no movement".
    const el = document.querySelector('[data-testid="message-list"]');
    const onFirst = () => {
      if (!w.__curveArmed) return;
      w.__curveArmed = false;
      const t0 = performance.now();
      const base = el.scrollTop;
      w.__curve = { base, pts: [], done: false };
      const tick = () => {
        const t = performance.now() - t0;
        w.__curve.pts.push({ t: Math.round(t), d: Math.round(el.scrollTop - base) });
        if (t < 700) requestAnimationFrame(tick);
        else w.__curve.done = true;
      };
      requestAnimationFrame(tick);
    };
    addEventListener("mousemove", onMove, true);
    addEventListener("wheel", onWheel, { capture: true, passive: true });
    addEventListener("wheel", onFirst, { capture: true, passive: true });
    w.__ws = { wheel: [] };
    w.__scaleReset = () => { w.__ws = { wheel: [] }; };
    w.__armCurve = () => { w.__curve = null; w.__curveArmed = true; };
    w.__scaleCleanup = () => {
      removeEventListener("mousemove", onMove, true);
      removeEventListener("wheel", onWheel, true);
      removeEventListener("wheel", onFirst, true);
      w.__curveArmed = false;
    };
  });

  // ---- calibrate: an OSR JCEF pane has no child HWND, so find the page by
  // moving the real cursor and reading the page's own mousemove back. --------
  const seed = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  // The IDE window class is not stable across versions: the classic windowing
  // reports SunAwtFrame, the new UI on this machine reports Chrome_WidgetWin_1
  // (same class as the browser), so match the project title instead and keep
  // the other agent windows (WorkBuddy / Orca / ZCode) out.
  const frames = py("windows").frames;
  const frame =
    frames.find((f) => /pi-agent|webstorm/i.test(`${f.title}`) && !/workbuddy|orca|zcode/i.test(f.title)) ??
    frames.find((f) => f.class === "SunAwtFrame");
  if (!frame) throw new Error(`no IDE frame among ${frames.map((f) => f.class).join(",")}`);
  const focused = py("focus", frame.hwnd);
  note("ide focused", focused.matched, focused);
  const hits = [];
  for (let x = frame.rect.r - 320; x <= frame.rect.r - 30; x += 32) {
    for (let y = frame.rect.t + 50; y <= frame.rect.t + 560; y += 32) {
      const before = await page.evaluate(() => window.__wm.t);
      py("move", x, y);
      await sleep(55);
      const st = await page.evaluate(() => ({ t: window.__wm.t, x: window.__wm.x, y: window.__wm.y }));
      if (st.t > before) {
        hits.push({ screen: { x, y }, client: { x: st.x, y: st.y }, off: { x: x - st.x, y: y - st.y } });
        if (hits.length >= 2) break;
      }
    }
    if (hits.length >= 2) break;
  }
  if (hits.length < 2) throw new Error(`page not on screen (hits=${hits.length})`);
  const OFF = hits[0].off;
  result.calib = { off: OFF, stable: hits[0].off.x === hits[1].off.x && hits[0].off.y === hits[1].off.y, hits };
  note("page located on screen", result.calib.stable, result.calib);

  const box = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="message-list"]').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const pt = { x: Math.round(OFF.x + box.x + box.w / 2), y: Math.round(OFF.y + box.y + box.h / 2) };
  const aim = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return { inside: !!el && !!document.querySelector('[data-testid="message-list"]').contains(el) };
  }, [box.x + box.w / 2, box.y + box.h / 2]);
  note("aim point inside the transcript", aim.inside, { pt, aim, seed, box });

  const top = () => page.evaluate(() => document.querySelector('[data-testid="message-list"]').scrollTop);
  const setTop = (v) =>
    page.evaluate((t) => { const el = document.querySelector('[data-testid="message-list"]'); el.scrollTop = t; return el.scrollTop; }, v);

  // ---- optional in-page fix: scale the notch -------------------------------
  let factor = 0;
  // Takeovers from an earlier run in the same page would each apply their own
  // delta (measured: 1 then 1.5 read as 250px, i.e. both fired). Keep them in
  // a list so *all* of them can be removed, including for `--fix=none`.
  await page.evaluate(() => {
    for (const h of window.__scaleTakeovers ?? []) removeEventListener("wheel", h, true);
    window.__scaleTakeovers = [];
  });
  if (FIX.startsWith("scale:")) {
    factor = Number(FIX.slice(6)) || 1;
    await page.evaluate((k) => {
      const el = document.querySelector('[data-testid="message-list"]');
      el.style.scrollBehavior = "auto";
      const takeover = (e) => {
        if (e.ctrlKey || e.metaKey) return;
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        const px = e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        el.scrollTop += px * k;
        e.preventDefault();
      };
      window.__scaleTakeovers.push(takeover);
      addEventListener("wheel", takeover, { passive: false, capture: true });
    }, factor);
    note("injected scale takeover", null, { factor });
  }

  // ---- per-notch displacement ---------------------------------------------
  for (let s = 0; s < SAMPLES; s++) {
    await setTop(1200 + s * 200);
    await sleep(250);
    await page.evaluate(() => window.__scaleReset());
    const before = await top();
    py("wheel", pt.x, pt.y, -NOTCH, 1, 0);
    await sleep(420);
    const after = await top();
    const dys = await page.evaluate(() => window.__ws.wheel.map((e) => e.dy));
    const modes = await page.evaluate(() => window.__ws.wheel.map((e) => e.mode));
    result.samples.push({
      s, before: Math.round(before), after: Math.round(after),
      moved: Math.round(after - before), deltaY: dys, deltaMode: modes,
    });
    log(`  notch ${s}: ${Math.round(before)} -> ${Math.round(after)} = ${Math.round(after - before)}px  deltaY=${JSON.stringify(dys)} mode=${JSON.stringify(modes)}`);
  }

  // ---- settle curve: one notch, sampled page-side by rAF --------------------
  // CDP round-trips cost ~10ms each, which is the same order as the animation
  // being measured, so the curve is recorded inside the page instead. t=0 is
  // the wheel *arrival* — the python spawn that sends it costs ~100ms and
  // would otherwise read as scroll latency.
  await setTop(1500);
  await sleep(300);
  await page.evaluate(() => window.__armCurve());
  py("wheel", pt.x, pt.y, -NOTCH, 1, 0);
  await sleep(950);
  const curve = await page.evaluate(() => window.__curve);
  result.curve = { base: Math.round(curve.base), done: curve.done, pts: curve.pts };
  for (const ms of [16, 33, 66, 100, 200, 400]) {
    const at = curve.pts.filter((p) => p.t <= ms).pop();
    result.settle.push({ ms, moved: at ? at.d : null });
  }
  log(`  curve: ${curve.pts.map((p) => `${p.t}ms=${p.d}`).join("  ")}`);

  const moved = result.samples.map((s) => s.moved).filter((v) => v > 0).sort((a, b) => a - b);
  const median = moved.length ? moved[Math.floor(moved.length / 2)] : 0;
  const dys = result.samples.flatMap((s) => s.deltaY);
  // A real notch maps to a fixed WM_MOUSEWHEEL delta; Chromium derives the
  // pixel distance from it. Report the ratio against 100px (Chromium's own
  // default notch distance) so "slower than the IDE" becomes a number.
  result.summary = {
    notchPx: median,
    deltaY: dys[0] ?? null,
    deltaMode: result.samples[0]?.deltaMode?.[0] ?? null,
    vsChromium100: median ? +(median / 100).toFixed(2) : null,
    settle100ms: result.settle.find((p) => p.ms === 100)?.moved ?? null,
    settle400ms: result.settle.find((p) => p.ms === 400)?.moved ?? null,
  };
  note("one notch moves something", median > 0, result.summary);
  note("displacement measured", null, { samples: result.samples.length, values: result.samples.map((s) => s.moved) });
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
