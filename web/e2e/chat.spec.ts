import { test, expect } from "@playwright/test";

/**
 * Frontend e2e against the MockBridge (vite dev server, no IDE involved).
 * The same UI code runs inside JCEF — that path is covered by scripts/e2e-ide.mjs.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
});

test("streams a full scenario: thinking, text, tool card, final answer, stats", async ({ page }) => {
  await page.getByTestId("composer-input").fill("Fix the failing tests");
  await page.getByTestId("send-btn").click();

  await expect(page.getByTestId("item-user")).toHaveCount(1);
  await expect(page.getByTestId("item-assistant").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("thinking-block").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("tool-card").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".tool-name").first()).toHaveText("bash");

  // mock scenario settles with a final message mentioning the tool output
  await expect(page.locator(".markdown").last()).toContainText("hello from mock pi", { timeout: 30_000 });

  // status bar shows stats after settle
  await expect(page.getByTestId("status-context")).toContainText("%", { timeout: 15_000 });
  await expect(page.getByTestId("status-cost")).toContainText("$");
});

test("abort returns to send state", async ({ page }) => {
  await page.getByTestId("composer-input").fill("long task");
  await page.getByTestId("send-btn").click();
  await page.getByTestId("abort-btn").click({ timeout: 15_000 });
  await expect(page.getByTestId("send-btn")).toBeVisible({ timeout: 30_000 });
});

test("slash command completion inserts the selected command", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.pressSequentially("/sk");
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".slash-name").first()).toHaveText("/skill:pdf-tools");
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("/skill:pdf-tools ");
});

test("sessions tab lists sessions and switching returns to chat", async ({ page }) => {
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("sessions-view")).toBeVisible();
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(2);
  await expect(page.locator(".session-name").first()).toHaveText("Refactor auth module");

  await rows.nth(1).click();
  await expect(page.getByTestId("tab-chat")).toHaveClass(/tab-active/);
  await expect(page.getByTestId("composer-input")).toBeVisible();
});

test("image attach sends a user message with the image chip", async ({ page }) => {
  // 1x1 transparent PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.setInputFiles('input[type="file"]', {
    name: "tiny.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(page.getByTestId("image-chips")).toContainText("tiny.png");

  await page.getByTestId("composer-input").fill("What is in this image?");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("item-user")).toHaveCount(1);
  await expect(page.locator(".item-assistant").first()).toContainText("Here is my plan", { timeout: 30_000 });
});

test("model selector switches models via rpc", async ({ page }) => {
  await page.getByTestId("model-select").selectOption("mock/mock-model-mini");
  const emptySub = page.locator(".empty-sub");
  // After switching, the topbar select holds the new value
  await expect(page.getByTestId("model-select")).toHaveValue("mock/mock-model-mini");
  await expect(emptySub).toContainText("mock");
});
