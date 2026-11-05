import { expect, test, type Page } from "@playwright/test";

/**
 * Spec 008 — language selection end to end.
 * `?locale=zh` simulates a Chinese-language IDE (env.locale comes from the
 * bridge); the preference rides config.getPrefs / config.setPrefs.
 */

async function sendAndWait(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("a Chinese IDE renders Chinese tabs with the default 'system' preference", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("tab-chat")).toHaveText("聊天");
  await expect(page.getByTestId("tab-sessions")).toHaveText("会话");
  await expect(page.getByTestId("tab-manage")).toHaveText("管理");
});

test("an English IDE renders English tabs and no CJK residue", async ({ page }) => {
  await expect(page.getByTestId("tab-chat")).toHaveText("Chat");
  await expect(page.getByTestId("tab-sessions")).toHaveText("Sessions");
  await expect(page.getByTestId("tab-manage")).toHaveText("Manage");
  const cjk = await page.locator(".tabs").evaluate((el) => /[\u4e00-\u9fa5]/.test(el.textContent ?? ""));
  expect(cjk).toBe(false);
});

test("the Language row renders a segmented control with 3 options (US2 scenario 5)", async ({ page }) => {
  await page.getByTestId("options-btn").click();
  await expect(page.getByTestId("opt-language")).toBeVisible();
  // Language sits directly below the Theme row and has the same shape.
  const segments = page.getByTestId("opt-language").locator(".segment");
  await expect(segments).toHaveCount(3);
  await expect(segments.nth(0)).toHaveText(/Follow IDE/);
  await expect(segments.nth(1)).toHaveText("English");
  await expect(segments.nth(2)).toHaveText("中文");
});

test("switching to Chinese applies immediately and persists (US1 scenario 4)", async ({ page }) => {
  await page.getByTestId("options-btn").click();
  await page.getByTestId("opt-language-zh").click();
  await expect(page.getByTestId("tab-chat")).toHaveText("聊天");

  // The choice is persisted through config.setPrefs: a fresh webview keeps it.
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("tab-chat")).toHaveText("聊天");

  // Back to English via the segmented control.
  await page.getByTestId("options-btn").click();
  await page.getByTestId("opt-language-en").click();
  await expect(page.getByTestId("tab-chat")).toHaveText("Chat");
});

test("switching the language keeps the transcript and scroll position (US2 scenario 4)", async ({ page }) => {
  await sendAndWait(page, "language switch probe");
  await expect(page.getByTestId("item-user")).toHaveCount(1);
  const scrollTopBefore = await page.getByTestId("message-list").evaluate((el) => el.scrollTop);

  await page.getByTestId("options-btn").click();
  await page.getByTestId("opt-language-zh").click();
  await expect(page.getByTestId("tab-chat")).toHaveText("聊天");

  await expect(page.getByTestId("item-user")).toHaveCount(1);
  const scrollTopAfter = await page.getByTestId("message-list").evaluate((el) => el.scrollTop);
  expect(Math.abs(scrollTopAfter - scrollTopBefore)).toBeLessThanOrEqual(2);
});

test("the Chinese UI carries no untranslated ⟦key⟧ markers (FR-009)", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  const markers = await page.evaluate(() => document.body.innerText.includes("⟦"));
  expect(markers).toBe(false);
});

test("the outline and search chrome translate (US1 full flow)", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await sendAndWait(page, "中文探针");
  await page.getByTestId("outline-btn").click();
  await expect(page.getByTestId("session-outline")).toBeVisible();
  await expect(page.getByTestId("session-outline")).toContainText("消息");
  await page.getByTestId("outline-close").click();

  await page.getByTestId("search-btn").click();
  const placeholder = await page.getByTestId("search-input").getAttribute("placeholder");
  expect(placeholder).toBe("在会话中搜索");
});
