// One-off diagnostic: context window + usage of the live session.
import { chromium } from "@playwright/test";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];
const s = await p.evaluate(() => ({
  ctxText: document.querySelector('[data-testid="status-context"]')?.textContent ?? null,
  ctxTitle: document.querySelector('[data-testid="status-context"]')?.getAttribute("title") ?? null,
  barLevel: document.querySelector('[data-testid="status-context-bar"]')?.className ?? null,
  model: document.querySelector(".status-session")?.textContent ?? null,
  messages: document.querySelector('[data-testid="status-messages"]')?.textContent ?? null,
}));
console.log(JSON.stringify(s, null, 1));
process.exit(0);
