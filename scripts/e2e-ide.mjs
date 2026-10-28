/**
 * IDE e2e: drives the Pi Agent web UI inside a real JCEF browser.
 *
 * Prerequisites (started by scripts/e2e-ide.sh):
 *   PI_IDE_E2E=<mock-pi.mjs> PI_IDE_E2E_PROJECT=<project> ./gradlew runIde
 * which enables JCEF remote debugging on :9222 and auto-opens the tool window.
 *
 * Usage: node scripts/e2e-ide.mjs [--cdp http://127.0.0.1:9222] [--screenshot out.png]
 */
import { chromium } from "playwright";

const cdpArg = process.argv.indexOf("--cdp");
const CDP = cdpArg > -1 ? process.argv[cdpArg + 1] : "http://127.0.0.1:9222";
const shotArg = process.argv.indexOf("--screenshot");
const SCREENSHOT = shotArg > -1 ? process.argv[shotArg + 1] : null;

function fail(message) {
  console.error(`IDE-E2E FAIL: ${message}`);
  process.exit(1);
}

const browser = await chromium.connectOverCDP(CDP);
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().startsWith("http://127.0.0.1"));

if (!page) {
  fail("Pi Agent page not found on CDP targets (is the tool window open?)");
}

console.log(`attached to ${page.url()}`);

try {
  // 1. UI booted: empty state and composer visible.
  await page.waitForSelector('[data-testid="empty-state"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  console.log("✓ UI booted (empty state + composer)");

  // 2. Status bar shows the mock pi version (bridge + process live).
  await page.waitForFunction(
    () => document.querySelector('[data-testid="status-version"]')?.textContent?.includes("mock"),
    { timeout: 20_000 },
  );
  console.log("✓ pi process connected via bridge (version visible)");

  // 3. Send a prompt and watch the full mock scenario stream.
  await page.fill('[data-testid="composer-input"]', "Fix the failing tests");
  await page.click('[data-testid="send-btn"]');
  await page.waitForSelector('[data-testid="item-user"]', { timeout: 10_000 });
  await page.waitForSelector('[data-testid="item-assistant"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="thinking-block"]', { timeout: 15_000 });
  console.log("✓ user + assistant items, thinking block streaming");

  await page.waitForSelector('[data-testid="tool-card"]', { timeout: 30_000 });
  const toolText = await page.textContent('[data-testid="tool-card"]');
  if (!toolText.includes("bash")) fail(`tool card missing tool name, got: ${toolText}`);
  console.log("✓ tool card rendered (bash)");

  // 4. Run settles with the final message and stats refresh.
  await page.waitForFunction(
    () => document.body.innerText.includes("hello from mock pi"),
    { timeout: 45_000 },
  );
  console.log("✓ final assistant text rendered");
  await page.waitForSelector('[data-testid="status-context"]', { timeout: 20_000 });
  console.log("✓ session stats visible in status bar");

  // 5. Abort flow: start a new prompt, hit Stop, expect it to settle.
  await page.fill('[data-testid="composer-input"]', "second task that will be aborted");
  await page.click('[data-testid="send-btn"]');
  await page.waitForSelector('[data-testid="abort-btn"]', { timeout: 10_000 });
  await page.click('[data-testid="abort-btn"]');
  await page.waitForSelector('[data-testid="send-btn"]', { timeout: 30_000 });
  console.log("✓ abort works (composer back to send state)");

  if (SCREENSHOT) {
    await page.screenshot({ path: SCREENSHOT, fullPage: false });
    console.log(`✓ screenshot saved: ${SCREENSHOT}`);
  }

  console.log("IDE-E2E PASS");
  process.exit(0);
} catch (error) {
  await page.screenshot({ path: "build/e2e-ide-failure.png" }).catch(() => {});
  fail(error.message);
}
