import { test, expect, type Page } from "@playwright/test";

/**
 * Spec 016: a credential saved in the auth panel reaches the chat tab's model
 * picker without restarting pi.
 *
 * `?reload=strict` models the models.json case — the new provider only becomes
 * visible after `models.reload` ran. Without the auth panel triggering that
 * refresh these tests stay red, which is exactly the bug being fixed. The
 * default fixture models the auth.json case (pi re-reads it by itself).
 */

const SENTINEL = "SK-E2E-SENTINEL-XYZ";

async function addDeepseek(page: Page) {
  await page.getByTestId("auth-add").click();
  await expect(page.getByTestId("provider-add-form")).toBeVisible();
  await page.getByTestId("provider-add-pick").click();
  await page.getByTestId("provider-add-popover").waitFor();
  await page.getByTestId("provider-add-search").fill("deepseek");
  await page.locator('[data-testid="provider-add-option"][data-value="deepseek"]').click();
  await page.getByTestId("provider-add-key").fill(SENTINEL);
  await page.getByTestId("provider-add-submit").click();
  await expect(page.getByTestId("provider-add-saved")).toContainText("deepseek");
}

async function gotoAuth(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await expect(page.getByTestId("manage-view")).toBeVisible();
  await page.getByTestId("manage-tab-auth").click();
  await expect(page.getByTestId("auth-panel")).toBeVisible();
}

async function openModelPicker(page: Page) {
  await page.getByTestId("tab-chat").click();
  await page.getByTestId("model-chip").click();
  await expect(page.getByTestId("model-popover")).toBeVisible();
}

test("a saved credential is selectable in the model picker right away", async ({ page }) => {
  await gotoAuth(page);
  await addDeepseek(page);

  await openModelPicker(page);
  const option = page.locator('[data-model-key="deepseek/deepseek-auto-1"]');
  await expect(option).toBeVisible();

  // Selecting proves the catalog entry is actually usable, not just painted.
  await option.click();
  await expect(page.getByTestId("model-chip")).toContainText("deepseek Auto");
});

test("models.json additions arrive through the in-process reload (?reload=strict)", async ({ page }) => {
  await gotoAuth(page, "?reload=strict");
  await addDeepseek(page);

  await openModelPicker(page);
  await expect(page.locator('[data-model-key="deepseek/deepseek-auto-1"]')).toBeVisible();
});

test("the plugin's internal reload command stays out of slash completion", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await page.getByTestId("composer-input").fill("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(page.getByTestId("slash-menu").locator(".slash-name")).not.toContainText([
    "/pi-agent-reload-models",
  ]);
  await expect(page.locator(".slash-name").first()).toHaveText("/skill:pdf-tools");
});
