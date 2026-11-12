// One-off helper: restart pi via the panel's restart button, then report state.
import { chromium } from "@playwright/test";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];
await p.waitForSelector('[data-testid="tabs"]', { timeout: 20000 });
await p.getByTestId("restart-btn").click();
await p.waitForTimeout(8000);
const s = await p.evaluate(() => ({
  status: document.querySelector('[data-testid="status-dot"]')?.className,
  version: document.querySelector('[data-testid="status-version"]')?.textContent,
  items: document.querySelectorAll('[data-testid="item-user"], [data-testid="item-assistant"]').length,
}));
console.log("after restart:", JSON.stringify(s));
process.exit(0);
