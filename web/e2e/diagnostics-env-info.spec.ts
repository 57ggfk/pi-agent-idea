import { expect, test } from "@playwright/test";

/**
 * Diagnostics card + settings paths (036): node/npm versions and paths,
 * plugin version + build info, and `~/` display shortening of home-prefixed
 * paths with the shared responsive switch.
 */

async function openDiagnostics(page: import("@playwright/test").Page, query: string) {
  await page.goto(query ? `/?${query}` : "/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-tab-diagnostics").click();
  await expect(page.getByTestId("manage-env")).toBeVisible();
}

test("the diagnostics card shows node, npm and plugin build info (036 US1/US2)", async ({ page }) => {
  await openDiagnostics(page, "");
  await expect(page.getByTestId("env-node-version")).toHaveText("v22.19.0");
  await expect(page.getByTestId("env-node-path-full")).toContainText("/tmp/mock-home/tools/node");
  await expect(page.getByTestId("env-npm-version")).toHaveText("v22.19.0");
  await expect(page.getByTestId("plugin-version")).toHaveText("0.5.10-mock");
  await expect(page.getByTestId("plugin-build")).toContainText("2026-11-16 20:15");
  await expect(page.getByTestId("plugin-build")).toContainText("abc1234");
});

test("missing tools and blank build info degrade visibly, never blank (036 FR-002/FR-003)", async ({ page }) => {
  await openDiagnostics(page, "envdegrade=1");
  await expect(page.getByTestId("env-node-missing")).toBeVisible();
  await expect(page.getByTestId("env-npm-missing")).toBeVisible();
  // plugin version / build time fall back to the explicit "unknown" copy
  await expect(page.getByTestId("plugin-version")).toContainText("unknown");
  await expect(page.getByTestId("plugin-build")).toContainText("unknown");
});

test("home-prefixed paths shorten to ~/ on narrow panels (036 US3)", async ({ page }) => {
  await openDiagnostics(page, "");
  const full = page.getByTestId("env-node-path-full");
  const short = page.getByTestId("env-node-path-short");
  await expect(full).toContainText("/tmp/mock-home/tools/node");
  await expect(short).toHaveText("~/tools/node");

  // Wide: full visible, short hidden. Narrow (≤640px): swapped — same CSS
  // contract the skills rows have used since 034.
  await expect(full).toBeVisible();
  await expect(short).toBeHidden();
  await page.setViewportSize({ width: 500, height: 800 });
  await expect(short).toBeVisible();
  await expect(full).toBeHidden();
});

test("the settings panel shortens the settings.json path display-only (036 US3/US4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-tab-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();

  const full = page.locator('[data-testid="settings-panel"] .skill-path-full');
  const short = page.locator('[data-testid="settings-panel"] .skill-path-short');
  await expect(full).toHaveText("/tmp/mock-home/.pi/agent/settings.json");
  await expect(short).toHaveText("~/.pi/agent/settings.json");
  await expect(full).toBeVisible();
  await expect(short).toBeHidden();

  // Narrow: the short form. US4's display-only contract is structural — the
  // panel only ever sends the edited text to settingsWrite, never a path.
  await page.setViewportSize({ width: 500, height: 800 });
  await expect(short).toBeVisible();
  await expect(full).toBeHidden();
});
