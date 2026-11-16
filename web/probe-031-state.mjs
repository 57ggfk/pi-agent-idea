// One-off diagnostic: dump the panel's current state.
import { chromium } from "@playwright/test";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
console.log("contexts:", b.contexts().length, "pages:", b.contexts()[0].pages().length);
const p = b.contexts()[0].pages()[0];
console.log("url:", p.url().replace(/([?&]token=)[^&#]*/gi, "$1<redacted>"));
const s = await p.evaluate(() => ({
  title: document.title,
  tabs: [...document.querySelectorAll('[data-testid^="tab-"]')].map((e) => e.textContent),
  status: document.querySelector('[data-testid="status-dot"]')?.className ?? null,
  version: document.querySelector('[data-testid="status-version"]')?.textContent ?? null,
  exitBanner: !!document.querySelector('[data-testid="exit-banner"]'),
  items: document.querySelectorAll('[data-testid="item-user"], [data-testid="item-assistant"]').length,
  systemItems: document.querySelectorAll('[data-testid="system-item"]').length,
  bodySnippet: document.body.innerText.slice(0, 200),
}));
console.log(JSON.stringify(s, null, 1));
process.exit(0);
