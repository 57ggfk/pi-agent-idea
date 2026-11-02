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

test("model picker filters with space-separated keywords and switches model", async ({ page }) => {
  const search = page.getByTestId("model-search");

  await page.getByTestId("model-chip").click();
  await expect(page.getByTestId("model-popover")).toBeVisible();

  // space-separated keywords are ANDed against id/name/provider
  await search.fill("mini pro");
  await expect(page.getByTestId("model-empty")).toBeVisible();

  await search.fill("pro");
  await expect(page.getByTestId("model-option").first()).toContainText("Mock Model Pro");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("model-popover")).toBeHidden();

  // switch model through the search flow
  await page.getByTestId("model-chip").click();
  await expect(page.getByTestId("model-popover")).toBeVisible();
  await search.click();
  await search.pressSequentially("mini");
  await expect(page.getByTestId("model-option")).toHaveCount(1);
  await page.getByTestId("model-option").first().click();
  await expect(page.getByTestId("model-chip")).toContainText("Mock Model Mini");
  await expect(page.getByTestId("model-popover")).toBeHidden();

  // reopen: filter to the current model, which is checked in the list
  await page.getByTestId("model-chip").click();
  await expect(page.getByTestId("model-popover")).toBeVisible();
  await search.click();
  await search.pressSequentially("mini");
  await expect(page.getByTestId("model-option")).toHaveCount(1);
  await expect(page.locator(".model-option-check").first()).toHaveText("✓");
  await page.keyboard.press("Escape");
});

test("queue mode lives on the send button dropdown, grayed out when idle", async ({ page }) => {
  // idle: caret visible but disabled
  await expect(page.getByTestId("send-mode-caret")).toBeVisible();
  await expect(page.getByTestId("send-mode-caret")).toBeDisabled();

  // while streaming the caret enables and picks follow-up
  await page.getByTestId("composer-input").fill("long task");
  await page.getByTestId("send-btn").click();
  await page.waitForSelector('[data-testid="abort-btn"]', { timeout: 15_000 });
  await expect(page.getByTestId("send-mode-caret")).toBeEnabled();

  await page.getByTestId("send-mode-caret").click();
  await expect(page.getByTestId("send-mode-menu")).toBeVisible();
  await expect(page.getByTestId("send-mode-auto")).toHaveAttribute("aria-disabled", "true"); // auto invalid mid-run
  await page.getByTestId("send-mode-followUp").click();
  await expect(page.getByTestId("send-mode-menu")).toBeHidden();

  // queue a follow-up via Enter, then stop the run
  await page.getByTestId("composer-input").fill("afterwards summarize");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("queue-note")).toContainText("1 queued", { timeout: 10_000 });
  await page.getByTestId("abort-btn").click();
  await expect(page.getByTestId("send-mode-caret")).toBeDisabled({ timeout: 20_000 });
});

test("auto-approve is on by default", async ({ page }) => {
  await page.getByTestId("options-btn").click();
  await expect(page.getByTestId("options-menu")).toBeVisible();
  await expect(page.getByTestId("opt-approval")).toContainText("Auto-approve tool calls");
  await expect(page.getByTestId("opt-approval-toggle")).toHaveAttribute("aria-checked", "true");
});
