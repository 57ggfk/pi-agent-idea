// One-off cleanup v2: delete 031 probe sessions identified by their preview
// text (the auto-titler renames rows, but previews keep the marker line).
import { chromium } from "@playwright/test";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];
await p.waitForSelector('[data-testid="tabs"]', { timeout: 20000 });

await p.getByTestId("tab-sessions").click();
await p.waitForSelector('[data-testid="session-row"]', { timeout: 15000 });
await p.waitForTimeout(400);

const targets = await p.evaluate(() =>
  [...document.querySelectorAll('[data-testid="session-row"]')]
    .map((r) => ({
      file: r.getAttribute("title"),
      name: r.querySelector(".session-name")?.textContent?.trim() ?? "",
      prev: r.querySelector(".session-preview")?.textContent?.trim() ?? "",
    }))
    .filter((r) => r.prev.includes("031探针")),
);
console.log("to delete:", JSON.stringify(targets));

for (const row of targets) {
  const sel = `[data-testid="session-row"][title="${row.file.replace(/\\/g, "\\\\")}"]`;
  await p.locator(sel).hover();
  await p.locator(sel).locator('[data-testid="session-delete"]').click();
  await p.waitForTimeout(400);
  if ((await p.locator('[data-testid="confirm-dialog"]').count()) > 0) {
    await p.getByTestId("confirm-ok").click();
    await p.waitForTimeout(500);
  }
  console.log("deleted:", row.file.split("\\").pop(), "(" + row.name + ")");
}

const left = await p.evaluate(() =>
  [...document.querySelectorAll('[data-testid="session-row"]')]
    .map((r) => r.querySelector(".session-preview")?.textContent ?? "")
    .filter((t) => t.includes("031探针")),
);
console.log("remaining:", left.length);
process.exit(0);
