// 024 real-machine: per-row copy payload. Clipboard read goes through the OS
// (Get-Clipboard) because navigator.clipboard.readText() hangs inside JCEF.
// Run this file with the PowerShell tool, not from bash, so the shell wrapper
// does not have to parse the clipboard call.
import { execSync } from "node:child_process";
import { chromium } from "@playwright/test";

const step = (s) => console.log(`--- ${s}`);
const res = [];
const push = (n, ok, d) => {
  res.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} :: ${JSON.stringify(d)}`);
};
const clip = () => {
  try {
    return execSync(
      'powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard"',
      { encoding: "utf8", timeout: 8000 },
    )
      .replace(/\r\n/g, "\n")
      .trim();
  } catch (e) {
    return `ERR ${e.message.slice(0, 80)}`;
  }
};
const setClip = (v) => {
  try {
    execSync(`powershell -NoProfile -Command "Set-Clipboard -Value '${v}'"`, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
};

step("connect");
const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];
console.log("url:", p.url().slice(0, 55));

step("sessions tab");
if (await p.getByTestId("tab-sessions").count()) await p.getByTestId("tab-sessions").click();
await p.waitForSelector('[data-testid="session-row"]', { timeout: 15000 });
console.log("rows:", await p.getByTestId("session-row").count());

step("clipboard sanity");
console.log("set:", setClip("SENTINEL-BEFORE"), "read:", JSON.stringify(clip()));

const rowInfo = await p.evaluate(() =>
  [...document.querySelectorAll('[data-testid="session-row"]')].slice(0, 3).map((r, i) => ({
    i,
    text: r.innerText.replace(/\s+/g, " ").trim().slice(0, 60),
  })),
);

const payloads = [];
for (const r of rowInfo) {
  step(`copy row ${r.i}`);
  setClip("SENTINEL-BEFORE");
  await p.locator('[data-testid="session-row"]').nth(r.i).getByTestId("session-copy").click();
  await p.waitForTimeout(400);
  const v = clip();
  payloads.push(v);
  console.log(`  row text: ${r.text}`);
  console.log(`  clipboard: ${JSON.stringify(v)}`);
}

push("clipboard actually overwritten", payloads.every((v) => v !== "SENTINEL-BEFORE" && !v.startsWith("ERR")), payloads);
push(
  "payload is exactly 2 lines (title + id)",
  payloads.every((v) => v.split("\n").filter((s) => s.trim()).length === 2),
  payloads.map((v) => v.split("\n").length),
);
push("payloads distinct per row", new Set(payloads).size === payloads.length);
const idLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
push(
  "second line is a session id",
  payloads.every((v) => idLike.test((v.split("\n")[1] ?? "").trim())),
  payloads.map((v) => (v.split("\n")[1] ?? "").trim().slice(0, 14)),
);
push(
  "title line matches the clicked row",
  payloads.every((v, k) => rowInfo[k].text.includes(v.split("\n")[0].trim())),
  payloads.map((v, k) => ({ clipTitle: v.split("\n")[0].trim(), row: rowInfo[k].text.slice(0, 30) })),
);

await p.screenshot({ path: "../build/probe-024-real-copy.png" }).catch(() => {});
await p.getByTestId("tab-chat").click();
console.log("\nsummary: " + res.filter((r) => r.ok).length + "/" + res.length + " pass");
await b.close();
