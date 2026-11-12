#!/usr/bin/env node
/**
 * probe-switch-race-hang.mjs — switch while pi is stalled, the way a stuttering
 * machine behaves.
 *
 * Plain rapid switching does NOT fail on this box: 7 overlapping switches all
 * queue inside pi and drain in ~1.4s, well inside the 5s budget. The reported
 * failure needs the queue to be *slow*, which is what a stalled/hitching IDE
 * looks like from the store's point of view.
 *
 * So this probe suspends pi's process (NtSuspendProcess, same as 026's probe),
 * fires N switches into the void, then resumes. The last switch's deadline has
 * to absorb the whole stall plus the queue behind it — the exact shape of the
 * user's "还在加载就点了下一个 → 切换会话失败".
 *
 * SAFETY: resume runs in a finally block, so pi cannot be left suspended even
 * if the probe throws.
 *
 * Usage: node probe-switch-race-hang.mjs [port] [stallMs] [taps]
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 9222);
const STALL = Number(process.argv[3] || 4000);
const TAPS = Number(process.argv[4] || 7);
const PI_PID = Number(process.env.PI_PID || 0);
const OUT = process.env.PROBE_OUT || "probe-switch-race-hang.json";

const py = (cmd) =>
  execFileSync("python", [join(HERE, "probe_suspend.py"), String(PI_PID), cmd], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const result = { at: new Date().toISOString(), piPid: PI_PID, stallMs: STALL, taps: TAPS, perf: [] };
let browser;
let suspended = false;
try {
  if (!PI_PID) throw new Error("set PI_PID");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("127.0.0.1"));
  if (!page) throw new Error("no pi webview among CDP pages");
  result.page = page.url().replace(/([?&]token=)[^&#]*/gi, "$1<redacted>");

  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("perf switch.")) result.perf.push({ t: Date.now(), text: t });
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="tabs"]', { timeout: 60_000 });
  await page.waitForTimeout(1_500);
  await page.getByTestId("tab-sessions").click();
  await page.waitForSelector('[data-testid="session-row"]', { timeout: 20_000 });
  await page.getByTestId("sessions-filter").fill("你好");
  await page.waitForTimeout(3_000);

  const ready = await page.evaluate((n) => {
    const btns = [...document.querySelectorAll('[data-testid="session-hit-snippet"]')];
    return btns.length >= n ? btns.length : 0;
  }, TAPS);
  if (!ready) throw new Error(`search produced < ${TAPS} snippets`);
  result.snippets = ready;

  // ---- stall pi, then fire every tap into the stall ------------------------
  const t0 = Date.now();
  result.suspend = py("suspend");
  suspended = true;
  // All taps land inside the stall: each one reaches switchSession, none of
  // their RPCs can be answered until resume.
  const fired = await page.evaluate((n) => {
    const btns = [...document.querySelectorAll('[data-testid="session-hit-snippet"]')];
    const step = Math.max(1, Math.floor(btns.length / n));
    let count = 0;
    for (let i = 0, k = 0; k < n && i < btns.length; i += step, k++) {
      btns[i].click();
      count++;
    }
    return count;
  }, TAPS);
  result.fired = fired;
  await sleep(STALL);
  result.resume = py("resume");
  suspended = false;
  result.stallActual = Date.now() - t0;

  // Give the queue its head: N switches + their reads have to drain.
  await page.waitForTimeout(Math.max(10_000, TAPS * 1_200));

  result.errors = await page.evaluate(() => {
    const t = document.body.innerText;
    const out = [];
    let i = 0;
    while ((i = t.indexOf("切换会话失败", i)) >= 0) {
      out.push(t.slice(i, i + 90).replace(/\n/g, " "));
      i += 6;
    }
    return out;
  });
  result.settled = await page.evaluate(() => ({
    onSessions: !!document.querySelector('[data-testid="session-row"]'),
    items: document.querySelectorAll('[data-testid^="item-"]').length,
    pending: !!document.querySelector('[data-testid="switch-pending"], .switch-pending'),
  }));

  const t1 = result.perf[0]?.t || Date.now();
  result.perf = result.perf.map((p) => ({ t: p.t - t1, text: p.text.slice(0, 160) }));
  const failed = result.perf.filter((p) => p.text.includes("switch.failed"));
  const pendings = result.perf.filter((p) => p.text.includes("switch.pending")).length;
  const readies = result.perf.filter((p) => p.text.includes("switch.ready")).length;
  result.checks = [
    { name: "pi 卡顿期间连切不产生「切换会话失败」", ok: result.errors.length === 0, detail: result.errors },
    { name: "没有 switch.failed 埋点", ok: failed.length === 0, detail: failed.map((f) => f.text) },
    { name: "并发确实成立（pending 数 > 1）", ok: pendings > 1, detail: { pendings, readies } },
    { name: "最终落在有内容的会话上", ok: !result.settled.onSessions && result.settled.items > 0, detail: result.settled },
  ];
  for (const c of result.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  ${c.ok ? "" : JSON.stringify(c.detail).slice(0, 400)}`);
  console.log(`stall=${result.stallActual}ms fired=${fired} pendings=${pendings} readies=${readies}`);
  console.log("perf:");
  for (const p of result.perf) console.log(`  +${String(p.t).padStart(6)}ms  ${p.text}`);
} catch (e) {
  result.error = String(e && e.stack ? e.stack : e).slice(0, 1200);
  console.log("ERROR", result.error);
} finally {
  if (suspended) {
    try {
      result.resume = py("resume");
      console.log("safety resume ->", result.resume);
    } catch (e) {
      console.log("SAFETY RESUME FAILED", e);
    }
  }
  writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
  console.log(`verdict -> ${OUT}`);
  if (browser) await browser.close().catch(() => {});
}
