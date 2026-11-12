// Real-machine wheel probe for 022 US2: "at the bottom, wheel up does nothing".
//
// Why this exists next to probe-scroll-jcef.mjs / probe-scroll-hitch.mjs:
//   those drive the wheel through CDP, which injects pixel-precise deltas and
//   never enters Chromium's "one notch -> one scroll animation" path. The bug
//   lives in that path, so they stayed green while the real machine stuck.
//   This probe sends genuine WM_MOUSEWHEEL to the real window (win_wheel.py)
//   and only reads state through CDP.
//
// Preconditions: IDE started with -Dide.browser.jcef.debug.port=9222, the Pi
// Agent tool window open and visible.
//
// Usage: node probe-wheel-real.mjs [port] [rounds] [--fix=none|css|js]
//   --fix=css  injects overscroll-behavior:none on the scrollers before running
//   --fix=js   injects a preventDefault wheel takeover before running
// Writes probe-wheel-real.json to build/.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || process.env.JCEF_PORT || "9222";
const ROUNDS = Number(process.argv[3] || 6);
const FIX = (process.argv.find((a) => a.startsWith("--fix=")) || "--fix=none").slice(6);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUTDIR = join(ROOT, "build");
mkdirSync(OUTDIR, { recursive: true });
const OUT = join(OUTDIR, `probe-wheel-real-${FIX}.json`);
const PY = "python";

const result = { port: PORT, at: new Date().toISOString(), fix: FIX, page: null, calib: null,
                 env: null, rounds: [], checks: [], error: null };
const log = (...a) => console.log(...a);
function note(name, ok, detail) {
  result.checks.push({ name, ok, detail });
  log(`${ok === true ? "PASS" : ok === false ? "FAIL" : "INFO"}  ${name} :: ${JSON.stringify(detail)}`);
}

function py(...args) {
  const out = execFileSync(PY, [join(HERE, "win_wheel.py"), ...args.map(String)], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  result.page = page.url();

  // A fresh document: earlier runs (and the app itself) leave listeners and
  // injected styles on `window`, and a stale wheel listener silently doubles
  // every count this probe reports.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="tabs"], [data-testid="composer-input"]', { timeout: 60_000 });
  await page.waitForTimeout(1200);

  // ---- open the longest transcript ------------------------------------------
  const onChat = await page.evaluate(() => !!document.querySelector('[data-testid="message-list"]'));
  const itemCount = () => page.evaluate(() => document.querySelectorAll('[data-testid^="item-"]').length);
  if ((await itemCount()) < 10) {
    if (await page.getByTestId("tab-sessions").count()) {
      await page.getByTestId("tab-sessions").click();
      await page.waitForTimeout(800);
    }
    const rows = page.locator('[data-testid="session-row"]');
    const n = await rows.count();
    if (!n) throw new Error("sessions list is empty");
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
    await page.waitForTimeout(1500);
  }
  note("on chat with a long transcript", !onChat || (await itemCount()) > 10, { items: await itemCount() });

  // ---- env ------------------------------------------------------------------
  result.env = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]');
    return { innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio,
             items: document.querySelectorAll('[data-testid^="item-"]').length,
             scrollHeight: list?.scrollHeight ?? 0, clientHeight: list?.clientHeight ?? 0 };
  });
  note("transcript environment", null, result.env);

  // ---- instrumentation ------------------------------------------------------
  // The page outlives a probe run, so every run must first tear down whatever
  // the previous one left behind (listeners accumulate otherwise, and the
  // "wheel event count" would silently double).
  await page.evaluate(() => {
    if (window.__probeCleanup) window.__probeCleanup();
    if (window.__wheelTakeover) {
      removeEventListener("wheel", window.__wheelTakeover, true);
      window.__wheelTakeover = null;
    }
    document.getElementById("probe-fix")?.remove();

    const w = window;
    w.__wm = { t: 0, n: 0, x: 0, y: 0, last: 0 };
    w.__w = { wheel: [], scroll: [] };
    const onMove = (e) => {
      w.__wm.n += 1; w.__wm.t = Date.now(); w.__wm.x = e.clientX; w.__wm.y = e.clientY;
    };
    const onWheel = (e) => {
      w.__w.wheel.push({ t: Date.now(), dy: e.deltaY, mode: e.deltaMode });
    };
    const list = document.querySelector('[data-testid="message-list"]');
    const onScroll = () => w.__w.scroll.push(Date.now());
    addEventListener("mousemove", onMove, true);
    addEventListener("wheel", onWheel, { capture: true, passive: true });
    list.addEventListener("scroll", onScroll, { passive: true });
    w.__resetW = () => { w.__w = { wheel: [], scroll: [] }; };
    w.__probeCleanup = () => {
      removeEventListener("mousemove", onMove, true);
      removeEventListener("wheel", onWheel, true);
      list.removeEventListener("scroll", onScroll);
    };
  });

  if (FIX === "revert") {
    // Negative control on a *shipped* build: undo the stylesheet fix from the
    // page so the same binary can be measured both ways in one session.
    await page.evaluate(() => {
      const st = document.createElement("style");
      st.id = "probe-fix";
      st.textContent = `.message-list,.sessions-list,.model-list,.options-menu,
        .file-menu,.slash-menu,.manage-content,.queue-bar,.outline-list,
        .session-search-results{overscroll-behavior:auto !important}`;
      document.head.appendChild(st);
    });
    note("injected negative control", null, "overscroll-behavior: auto !important");
  }
  if (FIX === "css" || FIX === "css-min" || FIX === "css-contain") {
    const css = FIX === "css"
      ? `html,body{overscroll-behavior:none}
         .message-list,.sessions-list,.model-list,.options-menu{overscroll-behavior:none}`
      : FIX === "css-contain"
        ? `.message-list,.sessions-list,.model-list,.options-menu{overscroll-behavior:contain}`
        : `.message-list,.sessions-list,.model-list,.options-menu{overscroll-behavior:none}`;
    await page.evaluate((text) => {
      const st = document.createElement("style");
      st.id = "probe-fix";
      st.textContent = text;
      document.head.appendChild(st);
    }, css);
    note("injected css fix", null, css);
  }
  if (FIX === "js") {
    await page.evaluate(() => {
      const scrollable = (el) => {
        const oy = getComputedStyle(el).overflowY;
        return (oy === "auto" || oy === "scroll") && el.scrollHeight - el.clientHeight > 1;
      };
      window.__wheelTakeover = (e) => {
        if (e.ctrlKey || e.metaKey) return;
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        let el = e.target;
        while (el && el !== document.body && !scrollable(el)) el = el.parentElement;
        if (!el || !scrollable(el)) return;
        const px = e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        const before = el.scrollTop;
        el.scrollTop = before + px;
        if (el.scrollTop === before) {
          let up = el.parentElement;
          while (up && up !== document.body && !scrollable(up)) up = up.parentElement;
          if (up && scrollable(up)) up.scrollTop += px;
        }
        e.preventDefault();
      };
      addEventListener("wheel", window.__wheelTakeover, { passive: false, capture: true });
    });
    note("injected js takeover", null, "wheel + preventDefault + scrollTop");
  }

  // ---- calibration: find the page on screen --------------------------------
  // An OSR JCEF component has no child HWND, so Win32 cannot say where it is.
  // Move the real cursor and read back the page's own mousemove: two hits give
  // the offset exactly, and a mismatch on the second one would expose scaling.
  const listBox = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="message-list"]').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const seed = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const frame = py("windows").frames.find((f) => f.class === "SunAwtFrame");
  note("ide frame", null, frame);
  // Bring the IDE forward once; from here on the cursor only *moves* — a click
  // while hunting for the page could land on a message action button.
  const focused = py("focus", frame.hwnd);
  note("ide focused", focused.matched, focused);
  // The tool window is docked on the right; scan a coarse grid inside it.
  const candidates = [];
  for (let x = frame.rect.r - 320; x <= frame.rect.r - 30; x += 32) {
    for (let y = frame.rect.t + 50; y <= frame.rect.t + 560; y += 32) candidates.push({ x, y });
  }
  const hits = [];
  for (const c of candidates) {
    const before = await page.evaluate(() => window.__wm.t);
    py("move", c.x, c.y);
    await sleep(60);
    const st = await page.evaluate(() => ({ t: window.__wm.t, x: window.__wm.x, y: window.__wm.y }));
    if (st.t > before) {
      hits.push({ screen: c, client: { x: st.x, y: st.y }, off: { x: c.x - st.x, y: c.y - st.y } });
      if (hits.length >= 2) break;
    }
  }
  if (hits.length < 2) throw new Error(`page not found on screen (hits=${hits.length})`);
  const [h1, h2] = hits;
  result.calib = { hits, off1: h1.off, off2: h2.off, scaleOk: h1.off.x === h2.off.x && h1.off.y === h2.off.y };
  note("page located on screen (offset stable)", result.calib.scaleOk, result.calib);
  const OFF = h1.off;

  // ---- shared plumbing ------------------------------------------------------
  const resetCounters = () => page.evaluate(() => window.__resetW());
  const counters = () => page.evaluate(() => ({ wheel: window.__w.wheel.length, scroll: window.__w.scroll.length }));
  const dxys = () => page.evaluate(() => window.__w.wheel.map((e) => e.dy));
  const ovY = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).overscrollBehaviorY : null;
  }, sel);

  /** Screen point for an element's centre, plus a hit test that it is the one. */
  async function aim(selector) {
    const box = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight };
    }, selector);
    if (!box) throw new Error(`${selector} not mounted`);
    const pt = { x: Math.round(OFF.x + box.x + box.w / 2), y: Math.round(OFF.y + box.y + box.h / 2) };
    py("move", pt.x, pt.y);
    await sleep(120);
    const hit = await page.evaluate(([s, x, y]) => {
      const el = document.elementFromPoint(x, y);
      const host = document.querySelector(s);
      return { inside: !!el && !!host && host.contains(el), tag: (el && el.className) || "" };
    }, [selector, box.x + box.w / 2, box.y + box.h / 2]);
    const at = await page.evaluate(() => ({ x: window.__wm.x, y: window.__wm.y }));
    return { pt, box, hit, at, aimed: at.x === Math.round(box.x + box.w / 2) && at.y === Math.round(box.y + box.h / 2) };
  }

  /**
   * The user's exact gesture: park at the bottom, a few more down notches, then
   * one up notch immediately. `movedFirstUp` is the number that matters — it is
   * 0 when the latch wins.
   */
  async function runRounds(stage, selector, pt, rounds) {
    const readTop = () => page.evaluate((s) => document.querySelector(s).scrollTop, selector);
    const out = [];
    for (let r = 0; r < rounds; r++) {
      await page.evaluate((s) => {
        const el = document.querySelector(s);
        el.scrollTop = el.scrollHeight;
      }, selector);
      await sleep(350);
      await resetCounters();
      const bottom = await readTop();

      const downSent = py("wheel", pt.x, pt.y, -120, 5, 16);
      await sleep(120);
      const afterDown = await readTop();
      const cDown = await counters();

      py("wheel", pt.x, pt.y, 120, 1, 0);
      await sleep(60);
      const afterUp60 = await readTop();
      py("wheel", pt.x, pt.y, 120, 1, 0);
      await sleep(250);
      const afterUp310 = await readTop();
      const cUp = await counters();

      const round = {
        r, bottom: Math.round(bottom), afterDown: Math.round(afterDown),
        afterUp60: Math.round(afterUp60), afterUp310: Math.round(afterUp310),
        movedFirstUp: Math.round(bottom - afterUp60), movedTwoUp: Math.round(bottom - afterUp310),
        wheelEventsDown: cDown.wheel, scrollEventsDown: cDown.scroll,
        wheelEventsUp: cUp.wheel - cDown.wheel, scrollEventsUp: cUp.scroll - cDown.scroll,
        downSent: downSent.sent,
      };
      out.push(round);
      log(`  ${stage} round ${r}: bottom=${round.bottom} down->${round.afterDown} up1->${round.afterUp60} (moved ${round.movedFirstUp}) ` +
          `up2->${round.afterUp310} (moved ${round.movedTwoUp}) wheelUp=${round.wheelEventsUp} scrollUp=${round.scrollEventsUp}`);
    }
    return out;
  }

  // ---- stage 1: the transcript ---------------------------------------------
  const t1 = await aim('[data-testid="message-list"]');
  note("目标点落在消息列表内", t1.hit.inside && t1.aimed, t1);
  note("消息列表 overscroll-behavior", null, await ovY('[data-testid="message-list"]'));
  const target = t1.pt;

  // ---- diagnostics: is the wheel broken in general, or only at the bottom? --
  const diag = {};
  {
    const setTop = (v) => page.evaluate((t) => {
      const el = document.querySelector('[data-testid="message-list"]');
      el.scrollTop = t;
      return el.scrollTop;
    }, v);
    const nudge = async (delta) => {
      await resetCounters();
      const before = await page.evaluate(() => document.querySelector('[data-testid="message-list"]').scrollTop);
      py("wheel", target.x, target.y, delta, 1, 0);
      await sleep(150);
      const after = await page.evaluate(() => document.querySelector('[data-testid="message-list"]').scrollTop);
      return { before: Math.round(before), after: Math.round(after), dxy: await dxys() };
    };
    await setTop(4000); await sleep(200);
    diag.midUp = await nudge(120);
    await setTop(4000); await sleep(200);
    diag.midDown = await nudge(-120);

    await setTop(9e9); await sleep(200);
    diag.bottomUp1 = await nudge(120);
    await sleep(900);
    diag.bottomUp1AfterPause = await nudge(120);
    await setTop(9e9); await sleep(200);
    await resetCounters();
    py("wheel", target.x, target.y, 120, 3, 16);
    await sleep(300);
    diag.bottomUp3Burst = {
      from: Math.round(await page.evaluate(() => document.querySelector('[data-testid="message-list"]').scrollTop)),
      dxy: await dxys(),
    };
  }
  result.diag = diag;
  note("列表中部滚轮正常（上/下都动）",
       diag.midUp.after < diag.midUp.before && diag.midDown.after > diag.midDown.before, diag);
  // The control: parked at the bottom *without* extra down notches, one upward
  // notch works. This is what proves the extra notches — not "being at the
  // bottom" — arm the bug.
  note("对照组：无额外下滚时底部上滑正常", diag.bottomUp1.after < diag.bottomUp1.before, diag.bottomUp1);
  note("底部停 900ms 后再上滑", diag.bottomUp1AfterPause.after < diag.bottomUp1AfterPause.before, diag.bottomUp1AfterPause);

  result.rounds = await runRounds("transcript", '[data-testid="message-list"]', target, ROUNDS);

  // ---- stage 2: the session list -------------------------------------------
  let stage2 = null;
  if (await page.getByTestId("tab-sessions").count()) {
    await page.getByTestId("tab-sessions").click();
    await page.waitForTimeout(900);
    const t2 = await aim(".sessions-list");
    stage2 = { aim: t2, ov: await ovY(".sessions-list") };
    result.stage2 = stage2;
    const longEnough = t2.box.sh > t2.box.ch + 200;
    note("会话列表可滚（够长才有意义）", longEnough, { scrollHeight: t2.box.sh, clientHeight: t2.box.ch });
    note("会话列表 overscroll-behavior", null, stage2.ov);
    if (longEnough) {
      stage2.rounds = await runRounds("sessions", ".sessions-list", t2.pt, Math.min(ROUNDS, 3));
      const stuck2 = stage2.rounds.filter((r) => r.movedFirstUp <= 0);
      note("会话列表：到底再上滑立刻动", stuck2.length === 0,
           { rounds: stage2.rounds.length, stuck: stuck2.length,
             worstMoved: Math.min(...stage2.rounds.map((r) => r.movedFirstUp)) });
    }
  }

  const stuck = result.rounds.filter((r) => r.movedFirstUp <= 0);
  const noWheel = result.rounds.filter((r) => r.wheelEventsUp === 0);
  note("消息列表：每一轮「到底再上滑」都能立刻向上", stuck.length === 0,
       { rounds: result.rounds.length, stuck: stuck.length, worstMoved: Math.min(...result.rounds.map((r) => r.movedFirstUp)) });
  note("上滑滚轮事件确实到达页面", noWheel.length === 0, { roundsWithoutWheel: noWheel.length });
  const idx = result.rounds.findIndex((r) => r.movedFirstUp <= 0);
  if (idx >= 0) note("复现：卡住样本", null, result.rounds[idx]);
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
