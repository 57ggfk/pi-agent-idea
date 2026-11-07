import { expect, test, type Page } from "@playwright/test";

/**
 * Silent failures (spec 003).
 *
 * The bug these cover: `@` and `/` showed "No matching …" when the request had
 * actually failed, so "the menu is empty" had four possible causes and one
 * appearance. Every assertion here is about telling those causes apart — and
 * about the recovery path actually working without reopening the window.
 */

const SOURCE_IDS = [
  "files",
  "commands",
  "models",
  "thinkingLevels",
  "policy",
  "prefs",
  "sessions",
  "stats",
] as const;

const input = (page: Page) => page.getByTestId("composer-input");

async function openDiagnostics(page: Page) {
  await page.getByTestId("tab-manage").click();
  await expect(page.getByTestId("manage-view")).toBeVisible();
  await page.getByTestId("manage-tab-diagnostics").click();
  await expect(page.getByTestId("diagnostics-panel")).toBeVisible();
}

test("#1 a failed file list is not reported as 'no matching files'", async ({ page }) => {
  await page.goto("/?fail=files");
  await input(page).pressSequentially("@");

  const failed = page.getByTestId("file-menu-failed");
  await expect(failed).toBeVisible();
  await expect(failed).toContainText("Failed to load files");
  // The reason is on screen, not only in the console.
  await expect(page.getByTestId("file-menu-failed-detail")).toContainText("files");

  // The old, lying wording must be gone entirely.
  await expect(page.getByTestId("file-menu-empty")).toHaveCount(0);
  await expect(page.getByTestId("file-menu")).not.toContainText("No matching files");
});

test("#2 retry recovers the file list in place, without reopening the window", async ({ page }) => {
  await page.goto("/?fail=files");
  await input(page).pressSequentially("@");
  await expect(page.getByTestId("file-menu-failed")).toBeVisible();

  await page.getByTestId("file-menu-retry").click();

  // Same menu, now populated: no reload, no tab switch.
  await expect(page.getByTestId("file-menu")).toHaveAttribute("data-state", "list");
  await expect(page.getByTestId("file-menu").locator(".file-item").first()).toContainText("@");
  await expect(page.getByTestId("file-menu-failed")).toHaveCount(0);
});

test("#3 a second failure keeps the error visible and does not raise a dialog", async ({ page }) => {
  await page.goto("/?fail=files:2");
  await input(page).pressSequentially("@");
  await expect(page.getByTestId("file-menu-failed")).toBeVisible();

  // Retry #1 fails again: the menu must stay in the failed state instead of
  // flipping to "empty" or popping an alert.
  await page.getByTestId("file-menu-retry").click();
  await expect(page.getByTestId("file-menu-failed")).toBeVisible();
  await expect(page.getByTestId("file-menu-failed-detail")).toContainText("files");
  expect(await page.locator("dialog").count()).toBe(0);

  // Retry #2 is allowed to succeed and clears the failure entirely.
  await page.getByTestId("file-menu-retry").click();
  await expect(page.getByTestId("file-menu").locator(".file-item").first()).toBeVisible();
});

test("#4 a command list that failed says so, separately from the file list", async ({ page }) => {
  await page.goto("/?fail=commands");
  await input(page).pressSequentially("/");

  await expect(page.getByTestId("slash-menu-failed")).toContainText("Failed to load commands");
  await expect(page.getByTestId("slash-menu-empty")).toHaveCount(0);

  await page.getByTestId("slash-menu-retry").click();
  await expect(page.getByTestId("slash-menu").locator(".slash-item").first()).toBeVisible();
});

test("#5 an empty menu distinguishes loading from 'nothing matches'", async ({ page }) => {
  await page.goto("/?slow=files:1500");
  await input(page).pressSequentially("@");

  const loading = page.getByTestId("file-menu-loading");
  await expect(loading).toBeVisible();
  await expect(loading).toContainText("Loading files");
  await expect(page.getByTestId("file-menu-empty")).toHaveCount(0);

  // Resolves on its own, without any user action.
  await expect(page.getByTestId("file-menu").locator(".file-item").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("#6 a query with no match is a real answer: no retry offered", async ({ page }) => {
  await page.goto("/");
  await input(page).pressSequentially("@zzzz-no-such-file");

  await expect(page.getByTestId("file-menu-empty")).toContainText("No matching files");
  await expect(page.getByTestId("file-menu-retry")).toHaveCount(0);
  await expect(page.getByTestId("file-menu-failed")).toHaveCount(0);
});

test("#7 once pi reports running, a failed source recovers with no user action (FR-005)", async ({
  page,
}) => {
  await page.goto("/?fail=files&pistate=1");

  // Deliberately touch nothing: the file read failed while pi was "starting",
  // and the process lifecycle event must bring it back by itself.
  await openDiagnostics(page);
  await expect(page.getByTestId("diag-status-files")).toHaveText("Ready", { timeout: 15_000 });
});

test("#8 refresh picks up a file that disappeared since the last read (FR-006)", async ({ page }) => {
  await page.goto("/?files=volatile");
  await input(page).pressSequentially("@store.ts");
  await expect(page.getByTestId("file-menu")).toContainText("src/store/store.ts");

  await page.getByTestId("file-menu-refresh").click();

  // The second read no longer lists it, so the menu must stop offering it.
  await expect(page.getByTestId("file-menu")).not.toContainText("src/store/store.ts");
  await expect(page.getByTestId("file-menu-empty")).toBeVisible();
});

test("#9 diagnostics lists every source and separates failing from not loaded", async ({ page }) => {
  await page.goto("/?fail=models,stats");
  await openDiagnostics(page);

  for (const id of SOURCE_IDS) {
    await expect(page.getByTestId(`diag-row-${id}`)).toBeVisible();
  }

  await expect(page.getByTestId("diag-status-models")).toHaveText(/Failed/);
  await expect(page.getByTestId("diag-error-models")).toContainText("loading its configuration");
  await expect(page.getByTestId("diag-summary")).toHaveAttribute("data-state", "failed");
  await expect(page.getByTestId("diag-summary")).toContainText("2 sources failing");

  // Retry is per source and only clears the one that recovered.
  await page.getByTestId("diag-retry-models").click();
  await expect(page.getByTestId("diag-status-models")).toHaveText("Ready");
  await expect(page.getByTestId("diag-status-stats")).toHaveText(/Failed/);
  await expect(page.getByTestId("diag-summary")).toContainText("1 source failing");
  // A retry must never hijack the whole window with a modal.
  expect(await page.locator("dialog").count()).toBe(0);
});

test("#10 an unimplemented bridge call is 'Not supported', never a failure (FR-009)", async ({ page }) => {
  await page.goto("/?unsupported=policy");
  await openDiagnostics(page);

  await expect(page.getByTestId("diag-status-policy")).toHaveText("Not supported");
  // Not counted as a failure: nothing here is the user's to fix.
  await expect(page.getByTestId("diag-summary")).not.toHaveAttribute("data-state", "failed");
  await expect(page.getByTestId("diag-summary")).not.toContainText("failing");
  await expect(page.getByTestId("diag-retry-policy")).toBeDisabled();

  // "Not loaded yet" is its own state, not a watered-down failure: Sessions has
  // not been asked for in this session, and the panel must say exactly that.
  await expect(page.getByTestId("diag-summary")).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("diag-status-sessions")).toHaveText("Not loaded");
});

test("#12 with every source loaded the headline is one calm line (US4-2)", async ({ page }) => {
  await page.goto("/");
  // Sessions is the one source that only loads when its tab is opened.
  await page.getByTestId("tab-sessions").click();
  await expect(page.locator(".session-name").first()).toBeVisible();

  await openDiagnostics(page);
  await expect(page.getByTestId("diag-summary")).toHaveAttribute("data-state", "ok");
  await expect(page.getByTestId("diag-summary")).toContainText("All good");
  await expect(page.getByTestId("diag-row-files")).toHaveAttribute("data-status", "ready");
});

test("#13 a long error is truncated in the menu and kept whole in diagnostics (FR-011)", async ({
  page,
}) => {
  await page.goto("/?fail=files&longerror=1");
  await input(page).pressSequentially("@");

  const detail = page.getByTestId("file-menu-failed-detail");
  const summary = (await detail.textContent()) ?? "";
  // The menu must never grow a wall of stack trace.
  expect(summary.length).toBeLessThanOrEqual(200);
  expect(summary.endsWith("…")).toBe(true);

  // The full text still exists — one click away, in the diagnostics panel.
  await openDiagnostics(page);
  const full = (await page.locator('[data-testid="diag-details-files"] pre').textContent()) ?? "";
  expect(full.length).toBeGreaterThan(200);
  expect(full).toContain("upstream detail");
});

test("#11 the diagnostics table stays inside the tool window at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto("/?fail=models");
  await openDiagnostics(page);

  const overflow = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="diagnostics-panel"]')!;
    const app = document.querySelector(".app")!;
    return {
      panelRight: panel.getBoundingClientRect().right,
      appRight: app.getBoundingClientRect().right,
      scrollsSideways: panel.scrollWidth - panel.clientWidth,
    };
  });

  expect(overflow.panelRight).toBeLessThanOrEqual(overflow.appRight + 1);
  expect(overflow.scrollsSideways).toBeLessThanOrEqual(0);
});

test("#14 the pi environment (version, paths, update) lives in diagnostics, not on the manage root", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("tab-manage").click();
  await expect(page.getByTestId("manage-view")).toBeVisible();

  // The old squeezed env bar is gone from the manage root…
  await expect(page.getByTestId("manage-env")).toHaveCount(0);
  await expect(page.getByTestId("pi-update")).toHaveCount(0);
  // …while trust keeps its place there (the default project is trusted).
  await expect(page.getByTestId("trust-status")).toHaveAttribute("data-state", "trusted");

  await page.getByTestId("manage-tab-diagnostics").click();
  const env = page.getByTestId("manage-env");
  await expect(env).toBeVisible();
  await expect(env).toContainText("1.4.0-mock");
  await expect(env).toContainText("/usr/local/bin/pi");
  await expect(env).toContainText("~/.pi/agent");
  await expect(page.getByTestId("pi-update")).toBeVisible();
});
