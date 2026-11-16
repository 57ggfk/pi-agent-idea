/**
 * 033 real-machine probe: drives the Pi Agent web UI inside a real IDE over
 * CDP and exercises the package panel end to end — real `pi list` parsing
 * (Kotlin), real registry HTTP (market + version check), real pinned-install
 * upgrade semantics (mocked only at the pi *process* level via PI_IDE_E2E=real
 * + PI_CODING_AGENT_DIR sandbox).
 *
 * Prerequisite (started by the operator):
 *   PI_IDE_E2E=real PI_IDE_E2E_PROJECT=<repo>/test/e2e-project \
 *   PI_CODING_AGENT_DIR=<sandbox with one npm package installed> \
 *   ./gradlew runIde
 *
 * Usage: node scripts/probe-033-packages.mjs [--cdp http://127.0.0.1:9222]
 */
import { chromium } from "playwright";

const cdpArg = process.argv.indexOf("--cdp");
const CDP = cdpArg > -1 ? process.argv[cdpArg + 1] : "http://127.0.0.1:9222";

const results = [];
function check(name, ok, detail = "") {
  results.push({ n: name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(message) {
  console.error(`PROBE-033 FAIL: ${message}`);
  process.exit(1);
}

const browser = await chromium.connectOverCDP(CDP);
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().startsWith("http://127.0.0.1"));

if (!page) fail("Pi Agent page not found on CDP targets (is the tool window open?)");

console.log(`attached to ${page.url()}`);

try {
  await page.waitForSelector('[data-testid="empty-state"], [data-testid="composer-input"]', { timeout: 30_000 });
  check("UI booted");

  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-tab-packages").click();

  // The sandbox has exactly one npm package: openwiki (pinned 0.9.0 in the
  // settings, physical version 0.9.0). The structured row must show both the
  // source line pi printed and the version read from package.json.
  await page.waitForSelector('[data-testid="package-row"]', { timeout: 20_000 });
  const row = page.getByTestId("package-row").first();
  const rowText = await row.innerText();
  check("real pi list parsed into a structured row", rowText.includes("openwiki"), rowText.replace(/\n/g, " | "));
  const version = await page.getByTestId("package-version-0").innerText();
  check("version read from the resolved path", version.includes("0.9.0"), version);

  // Version check against the real registry (preflight + /latest): openwiki
  // 0.9.0 is the latest, so the verdict must be "Up to date (0.9.0)".
  await page.getByTestId("package-check-0").click();
  await page.waitForSelector('[data-testid="package-check-verdict-0"]', { timeout: 20_000 });
  const verdict = await page.getByTestId("package-check-verdict-0").innerText();
  check("real registry version check", verdict.includes("Up to date"), verdict);
  check("upgrade disabled when up to date", await page.getByTestId("package-upgrade-0").isDisabled());

  // The market tab hits the real npm registry search through the Kotlin HTTP
  // client: the first card is billion-context, same as pi.dev (P15/P16).
  await page.getByTestId("packages-tab-market").click();
  await page.waitForSelector('[data-testid="market-card"]', { timeout: 30_000 });
  const firstName = await page.getByTestId("market-name").first().innerText();
  const downloads = await page.getByTestId("market-downloads").first().innerText();
  const pageInfo = await page.getByTestId("market-pageinfo").innerText();
  check("real market search reached the npm registry", firstName.length > 0, firstName);
  check("download count formatted", /\d/.test(downloads), downloads);
  check("pager computed from the live total", /\/\s*\d+/.test(pageInfo), pageInfo);

  const npmmirrorCard = await page
    .getByTestId("market-name")
    .first()
    .evaluate(() => document.querySelectorAll('[data-testid="market-card"]').length);
  check("first page renders 50 cards", npmmirrorCard === 50, String(npmmirrorCard));

  // Registry preset row visible with follow-npm preselected.
  check("registry row present with follow mode", await page.getByTestId("package-registry-follow").isVisible());
  check("follow preselected", await page.getByTestId("package-registry-follow").isChecked());
} catch (e) {
  fail(e.message);
}

const pass = results.filter((r) => r.ok).length;
console.log(`\nPROBE-033: ${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
