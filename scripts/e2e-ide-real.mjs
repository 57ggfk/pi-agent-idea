/**
 * IDE e2e against the REAL pi binary with a REAL model.
 *
 * Prerequisite: `PI_IDE_E2E=real PI_IDE_E2E_PROJECT=<project> ./gradlew runIde`
 * (debug port :9222 + auto-opened tool window, no mock pi injection).
 * Requires the openrouter credential in ~/.pi/agent/auth.json and the
 * `openrouter/free` ("Free Models Router") model in ~/.pi/agent/models.json.
 *
 * Usage: node scripts/e2e-ide-real.mjs [--cdp http://127.0.0.1:9222]
 */
import { chromium } from "playwright";

const cdpArg = process.argv.indexOf("--cdp");
const CDP = cdpArg > -1 ? process.argv[cdpArg + 1] : "http://127.0.0.1:9222";
const MODEL_LABEL = "Free Models Router";
const PROMPT = "Reply with exactly: REAL_PI_OK";

function fail(message) {
  console.error(`REAL-IDE-E2E FAIL: ${message}`);
  process.exit(1);
}

const browser = await chromium.connectOverCDP(CDP);
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().startsWith("http://127.0.0.1"));

if (!page) fail("Pi Agent page not found on CDP targets");

console.log(`attached to ${page.url()}`);

try {
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });
  console.log("✓ UI booted");

  // Select the real model: bottom chip → search (space = AND) → Enter picks
  // the highlighted match.
  await page.getByTestId("model-chip").click();
  await page.fill('[data-testid="model-search"]', "Free Models Router");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="model-chip"]')?.textContent?.includes("Free Models Router"),
    { timeout: 10_000 },
  );
  console.log(`✓ model selected: ${MODEL_LABEL}`);
  await page.waitForTimeout(1500);

  // Pre-existing error items (e.g. from concurrent manual poking in this
  // window) are not this test's business; judge only what happens after the
  // prompt below.
  const errorsBefore = await page.locator(".item-error").count();

  await page.fill('[data-testid="composer-input"]', PROMPT);
  await page.click('[data-testid="send-btn"]');

  // The model may take a while (free router queues); allow 3 minutes.
  await page.waitForFunction(
    (needle) => document.body.innerText.includes(needle),
    "REAL_PI_OK",
    { timeout: 180_000 },
  );
  console.log("✓ real model response streamed and rendered");

  const errorsAfter = await page.locator(".item-error").count();
  if (errorsAfter > errorsBefore) {
    const text = await page.locator(".item-error").last().innerText();
    fail(`new error item after prompt: ${text.slice(0, 200)}`);
  }

  await page.screenshot({ path: "build/e2e-ide-real.png" });
  console.log("✓ screenshot: build/e2e-ide-real.png");
  console.log("REAL-IDE-E2E PASS");
  process.exit(0);
} catch (error) {
  await page.screenshot({ path: "build/e2e-ide-real-failure.png" }).catch(() => {});
  fail(error.message);
}
