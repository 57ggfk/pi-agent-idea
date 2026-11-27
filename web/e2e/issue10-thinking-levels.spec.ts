import { expect, test, type Page } from "@playwright/test";

/**
 * Issue #10 — saving a custom provider must refresh the thinking levels too.
 *
 * The model catalog and the thinking levels are two independent sources, but
 * they describe the same provider configuration. The provider save path goes
 * through reloadModels(), so both have to be re-read there — otherwise the
 * picker shows the new models while the thinking menu keeps the old list
 * until the panel is reopened.
 *
 * The fixture: `?fail=thinkingLevels` makes the FIRST reading of the
 * thinking levels fail (the mock's failure budget is one request). The boot
 * read therefore fails and the menu falls back to the current level. The
 * provider save reads them again — and that second read succeeds. Without
 * the fix the menu would stay empty until the panel was reopened.
 */

async function openManage(page: Page, query = "") {
  await page.goto(query ? `/?${query}` : "/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await expect(page.getByTestId("manage-view")).toBeVisible();
}

/** Saves a credential for a provider (the path that refreshes the catalog). */
async function addProvider(page: Page) {
  // The credential form lives in the auth tab.
  await page.getByTestId("manage-tab-auth").click();
  await expect(page.getByTestId("auth-panel")).toBeVisible();
  await page.getByTestId("auth-add").click();
  await expect(page.getByTestId("provider-add-form")).toBeVisible();
  await page.getByTestId("provider-add-pick").click();
  await page.getByTestId("provider-add-popover").waitFor();
  await page.getByTestId("provider-add-search").fill("deepseek");
  await page.locator('[data-testid="provider-add-option"][data-value="deepseek"]').click();
  await page.getByTestId("provider-add-key").fill("SK-E2E-SENTINEL-XYZ");
  await page.getByTestId("provider-add-submit").click();
  await expect(page.getByTestId("provider-add-saved")).toContainText("deepseek");
}

/** The thinking levels the picker offers. */
async function thinkingLevels(page: Page): Promise<string[]> {
  await page.getByTestId("tab-chat").click();
  await page.getByTestId("thinking-select").click();
  const menu = page.getByTestId("thinking-menu");
  await expect(menu).toBeVisible();
  const levels = await menu.locator(".slash-name").allTextContents();
  await page.keyboard.press("Escape");
  return levels;
}

test("the thinking levels are refreshed by the provider save (issue #10)", async ({ page }) => {
  await openManage(page, "fail=thinkingLevels");

  // The boot read failed → the menu falls back to the current level alone.
  const before = await thinkingLevels(page);
  expect(before).toEqual(["medium"]);

  await openManage(page, "fail=thinkingLevels");
  await addProvider(page);

  // The save refreshed the thinking levels as well — no restart, no reopen.
  const after = await thinkingLevels(page);
  expect(after).toEqual(["off", "minimal", "low", "medium", "high"]);
});

test("the thinking levels survive a provider save that cannot read them (issue #10)", async ({ page }) => {
  await openManage(page, "fail=thinkingLevels:2");

  const before = await thinkingLevels(page);
  expect(before).toEqual(["medium"]);

  await openManage(page, "fail=thinkingLevels:2");
  await addProvider(page);

  // The reading failed again — the model catalog still refreshed, and the
  // menu falls back to the current level instead of going blank.
  await page.getByTestId("tab-chat").click();
  await page.getByTestId("model-chip").click();
  await expect(page.getByTestId("model-popover")).toBeVisible();
  await page.keyboard.press("Escape");

  const after = await thinkingLevels(page);
  expect(after.length).toBeGreaterThan(0);
});
