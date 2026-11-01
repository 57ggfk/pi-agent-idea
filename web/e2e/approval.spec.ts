import { expect, test } from "@playwright/test";

// The mock gates its bash tool call behind an approval dialog only when the
// page is loaded with ?approval=1 (mirrors the pi-approve extension in ask
// mode); the other specs keep the ungated timing.
test.beforeEach(async ({ page }) => {
  await page.goto("/?approval=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

async function send(page: import("@playwright/test").Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
}

test("ask mode gates the bash tool call until approved", async ({ page }) => {
  await send(page, "run the check");

  // The run blocks on the approval card.
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("approval-title")).toContainText("Allow bash?");
  await expect(page.getByTestId("approval-message")).toContainText("echo hello from mock pi");

  // Allow: the tool executes, the card disappears, the run settles.
  await page.getByTestId("approval-allow").click();
  await expect(page.locator(".tool-card", { hasText: "hello from mock pi" }).first()).toBeVisible({
    timeout: 15000,
  });
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 15000 });
});

test("denying blocks the tool with an error result", async ({ page }) => {
  await send(page, "run the check");

  await expect(page.getByTestId("approval-card")).toBeVisible();
  await page.getByTestId("approval-deny").click();

  const denied = page.locator(".tool-card.tool-error", { hasText: "bash" }).first();
  await expect(denied).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  // The run still settles (the model sees the block reason).
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 15000 });
});

test("yolo mode runs tools without asking", async ({ page }) => {
  await page.getByTestId("options-btn").click();
  await expect(page.getByTestId("options-menu")).toBeVisible();
  await page.getByTestId("opt-approval-toggle").click();
  // Close the menu by clicking outside it.
  await page.getByTestId("composer-input").click();

  await send(page, "run the check");

  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await expect(page.locator(".tool-card", { hasText: "hello from mock pi" }).first()).toBeVisible({
    timeout: 15000,
  });
});
