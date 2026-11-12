// 026 FR: clicking 新建会话 while pi is hung must produce a visible error item
// instead of being swallowed. 新建 asks for confirmation first, so the probe
// confirms the dialog and only then does the timeout matter.
import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";

const PID = process.argv[2] || "24720";
const res = [];
const push = (n, ok, d) => {
  res.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} :: ${JSON.stringify(d)}`);
};
const ctl = (a) => console.log(`  [${a}] ${execSync(`python probe_suspend.py ${PID} ${a}`, { encoding: "utf8" }).trim()}`);

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];

// clear any dialog left over from an earlier run
if (await p.getByTestId("confirm-dialog").count()) {
  await p.getByTestId("confirm-cancel").click().catch(() => {});
  await p.waitForTimeout(300);
}

await p.getByTestId("tab-sessions").click();
await p.waitForSelector('[data-testid="session-row"]', { timeout: 15000 });
await p.waitForTimeout(400);
const rowsBefore = await p.getByTestId("session-row").count();
console.log("rows before:", rowsBefore);

const snap = () =>
  p.evaluate(() => ({
    errors: [...document.querySelectorAll('[data-testid="system-item"].item-error')].map((e) => e.textContent.trim().slice(0, 120)),
    items: document.querySelectorAll('[data-testid="message-list"] .item').length,
    onChat: !!document.querySelector('[data-testid="message-list"]'),
    dialog: document.querySelector('[data-testid="confirm-dialog"]')?.getAttribute("data-testid") ?? null,
    retryBar: document.querySelectorAll('[data-testid="switch-retry-bar"]').length,
  }));

let hung = false;
try {
  await p.getByTestId("tab-chat").click();
  await p.waitForTimeout(400);
  ctl("suspend");
  hung = true;

  await p.getByTestId("new-session").click({ timeout: 5000 });
  // 新建 over a non-empty transcript asks first
  if (await p.getByTestId("confirm-dialog").count()) {
    console.log("  confirm dialog shown, confirming");
    await p.getByTestId("confirm-ok").click();
  }
  const t0 = Date.now();

  let hit = null;
  const deadline = Date.now() + 14000;
  while (Date.now() < deadline) {
    const s = await snap();
    if (s.errors.length) {
      hit = { at: Date.now() - t0, ...s };
      break;
    }
    await p.waitForTimeout(120);
  }
  push("a hung new-session shows an error item in the transcript", !!hit, {
    at: hit?.at ?? null,
    error: hit?.errors?.[0] ?? null,
  });
  if (hit) push("the error arrives inside the 8s budget", hit.at <= 8000, { at: hit.at });
  await p.screenshot({ path: "../build/probe-026-real-newsession.png" }).catch(() => {});
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

await p.waitForTimeout(4000);
await p.getByTestId("tab-sessions").click().catch(() => {});
await p.waitForTimeout(1200);
const rowsAfter = await p.getByTestId("session-row").count();
console.log("rows after:", rowsAfter, "(a late new_session answer can add an empty session)");
await p.getByTestId("tab-chat").click().catch(() => {});

console.log("\nsummary: " + res.filter((r) => r.ok).length + "/" + res.length + " pass");
await b.close();
