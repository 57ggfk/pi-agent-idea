import { test, expect } from "@playwright/test";

/**
 * Built-in slash commands (0.5.12 first pass): pi's TUI-layer commands lead
 * the slash menu and execute on plugin surfaces instead of being sent to the
 * LLM as text. The RPC-side commands (templates / skills / extensions) keep
 * their text-insert behavior — covered in chat.spec.ts ("/sk" → Tab).
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
});

test("slash menu lists the seven built-ins before pi-side commands", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.pressSequentially("/");
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toBeVisible();
  const names = await menu.locator(".slash-name").allInnerTexts();
  expect(names.slice(0, 7)).toEqual([
    "/model",
    "/thinking",
    "/new",
    "/compact",
    "/clone",
    "/resume",
    "/settings",
  ]);
});

test("/model opens the model picker and clears the input", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.pressSequentially("/model");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("model-popover")).toBeVisible();
  // The command executed — the typed text must not linger (or go out as a message).
  await expect(input).toHaveValue("");
});

test("/resume switches to the sessions tab", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.pressSequentially("/resume");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sessions-view")).toBeVisible();
  await expect(page.getByTestId("tab-chat")).not.toHaveClass(/tab-active/);
});

test("/settings switches to the manage tab", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.pressSequentially("/settings");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("manage-view")).toBeVisible();
});

test("a partial query still filters across built-ins and pi-side commands", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.pressSequentially("/se");
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toBeVisible();
  // "se" hits the built-in /settings and no mock command starts with it.
  const names = await menu.locator(".slash-name").allInnerTexts();
  expect(names[0]).toBe("/settings");
});
