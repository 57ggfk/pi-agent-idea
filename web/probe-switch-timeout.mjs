// 026 real-machine: a genuinely hung pi (NtSuspendProcess, restored afterwards)
// must produce the switch-failure bar within the 8s budget, put the list back,
// and let the retry re-send the original target once pi answers again.
//
// Requires web/probe_suspend.py and the pid of the `pi --mode rpc` process.
import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";

const PID = process.argv[2] || "24720";
const res = [];
const push = (n, ok, d) => {
  res.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} :: ${JSON.stringify(d)}`);
};
const ctl = (a) => {
  const out = execSync(`python probe_suspend.py ${PID} ${a}`, { encoding: "utf8" }).trim();
  console.log(`  [${a}] ${out}`);
};

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];

const state = () =>
  p.evaluate(() => ({
    rows: document.querySelectorAll('[data-testid="session-row"]').length,
    pending: document.querySelectorAll(".session-pending").length,
    retryBar: document.querySelectorAll('[data-testid="switch-retry-bar"]').length,
    onChat: !!document.querySelector('[data-testid="message-list"]'),
    currentFile: document.querySelector('[data-testid="session-row"].session-current')?.getAttribute("title") ?? null,
    switching: !!document.querySelector('[data-testid="switching-placeholder"]'),
  }));

// ---- pick a non-current target that is NOT one of the probe rows ----
await p.getByTestId("tab-sessions").click();
await p.waitForSelector('[data-testid="session-row"]', { timeout: 15000 });
await p.waitForTimeout(300);
const before = await state();
const target = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="session-row"]')];
  const cur = document.querySelector('[data-testid="session-row"].session-current');
  const curFile = cur?.getAttribute("title");
  const cand = rows.find((r) => {
    const f = r.getAttribute("title");
    if (f === curFile) return false;
    const name = r.querySelector(".session-name")?.textContent?.trim() ?? "";
    const prev = r.querySelector(".session-preview")?.textContent ?? "";
    const msgs = Number(prev.match(/(\d+)\s*条消息/)?.[1] ?? 0);
    return msgs >= 3 && name.length > 0;
  });
  return cand ? { file: cand.getAttribute("title"), name: cand.querySelector(".session-name")?.textContent?.trim() } : null;
});
console.log("current:", before.currentFile?.split("\\").pop());
console.log("target:", JSON.stringify({ file: target?.file?.split("\\").pop(), name: target?.name }));
if (!target) throw new Error("no target row");

const sel = `[data-testid="session-row"][title="${target.file.replace(/\\/g, "\\\\")}"]`;

let hung = false;
try {
  // ---- hang pi, then ask for a switch ----
  ctl("suspend");
  hung = true;
  const t0 = Date.now();
  await p.locator(sel).locator(".session-row-main").click({ timeout: 5000 }).catch((e) => console.log("  click:", e.message.slice(0, 60)));

  // poll until the failure bar shows up
  let shownAt = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const s = await state();
    if (s.retryBar > 0) {
      shownAt = Date.now() - t0;
      console.log("  failure bar after", shownAt, "ms; state:", JSON.stringify(s));
      break;
    }
    await p.waitForTimeout(100);
  }
  const elapsed = shownAt ?? Date.now() - t0;
  push("switch fails within the 8s budget", shownAt != null && elapsed <= 9000, { elapsed, shown: shownAt != null });
  const afterFail = await state();
  push("pending state cleared (list is interactive again)", afterFail.pending === 0, { pending: afterFail.pending });
  push("back on the list, chat tab not showing a dead transcript", afterFail.onChat === false || afterFail.retryBar > 0, { onChat: afterFail.onChat, retryBar: afterFail.retryBar });
  push("live session was not switched by the failed attempt", afterFail.currentFile === before.currentFile, {
    before: before.currentFile?.split("\\").pop(),
    after: afterFail.currentFile?.split("\\").pop(),
  });
  await p.screenshot({ path: "../build/probe-026-real-failed.png" }).catch(() => {});

  // ---- bring pi back, then retry ----
  ctl("resume");
  hung = false;
  await p.waitForTimeout(1500); // let the Kotlin side drain the blocked RPC
  await p.getByTestId("switch-retry-btn").click();
  let reopened = false;
  try {
    // a successful switch lands on the chat tab with a real transcript
    await p.waitForSelector('[data-testid="message-list"]', { timeout: 20000 });
    reopened = true;
  } catch {}
  push("retry brings the transcript back", reopened, { reopened });
  // the rows only exist on the list tab, so read the current session there
  await p.getByTestId("tab-sessions").click();
  await p.waitForSelector('[data-testid="session-row"]', { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(300);
  const afterRetry = await state();
  push("retry switches to the original target after pi recovers", afterRetry.currentFile === target.file, {
    current: afterRetry.currentFile?.split("\\").pop(),
    want: target.file.split("\\").pop(),
    retryBar: afterRetry.retryBar,
  });
  push("failure bar gone after a successful retry", afterRetry.retryBar === 0, { retryBar: afterRetry.retryBar });
  await p.screenshot({ path: "../build/probe-026-real-recovered.png" }).catch(() => {});

  // ---- put the user back where they were ----
  const backSel = `[data-testid="session-row"][title="${before.currentFile.replace(/\\/g, "\\\\")}"]`;
  await p.locator(backSel).locator(".session-row-main").click().catch(() => {});
  await p.waitForTimeout(2500);
  await p.getByTestId("tab-sessions").click().catch(() => {});
  await p.waitForTimeout(400);
  const final = await state();
  push("restored the original session on screen", final.currentFile === before.currentFile, {
    current: final.currentFile?.split("\\").pop(),
  });
  await p.getByTestId("tab-chat").click().catch(() => {});
} finally {
  if (hung) {
    console.log("  [cleanup] resuming pi");
    try {
      ctl("resume");
    } catch (e) {
      console.error("  resume failed:", e.message);
    }
  }
}

console.log("\nsummary: " + res.filter((r) => r.ok).length + "/" + res.length + " pass");
await b.close();
