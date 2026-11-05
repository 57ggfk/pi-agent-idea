import { expect, test, type Page } from "@playwright/test";

/**
 * Spec 006 US1 — user-message outline.
 *
 * The outline is the table of contents of a long session: every user message,
 * in order, one click away from a flash-highlighted jump.
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

test("an empty session hides the outline entry (FR-003)", async ({ page }) => {
  await expect(page.getByTestId("outline-btn")).toHaveCount(0);
  await expect(page.getByTestId("session-outline")).toHaveCount(0);
});

test("the outline lists every user message in order and jumps to the clicked one", async ({ page }) => {
  test.setTimeout(240_000);
  const rounds = 30;
  for (let i = 1; i <= rounds; i++) {
    await sendAndWait(page, `outline question ${i} uniq`);
  }
  await expect(page.getByTestId("item-user")).toHaveCount(rounds);

  await page.getByTestId("outline-btn").click();
  const items = page.getByTestId("outline-item");
  await expect(items).toHaveCount(rounds);
  // First entry is the earliest question (US1 scenario 1).
  await expect(items.first()).toContainText("outline question 1");
  await expect(items.nth(2)).toContainText("outline question 3");

  // Jump to the 3rd question: the flash class lands synchronously at click,
  // the smooth scroll then settles the message 0–40px below the list top
  // (T001), and the flash fades after ~2s.
  await items.nth(2).click();
  const list = page.getByTestId("message-list");
  const third = page.locator('.item[data-item-id]').filter({ hasText: "outline question 3 uniq" }).first();
  await expect(third).toHaveClass(/flash-target/);
  await expect.poll(async () => {
    const r = await third.boundingBox();
    const l = await list.boundingBox();
    if (!r || !l) return -1000;
    return r.y - l.y;
  }).toBeLessThanOrEqual(40);
  await expect.poll(async () => {
    const r = await third.boundingBox();
    const l = await list.boundingBox();
    if (!r || !l) return 1000;
    return r.y - l.y;
  }).toBeGreaterThanOrEqual(0);
  // The flash must be gone once the 2s highlight window has passed.
  await page.waitForTimeout(2300);
  await expect(third).not.toHaveClass(/flash-target/);

  // The outline stays open and marks the jumped entry as current.
  await expect(page.getByTestId("session-outline")).toBeVisible();
  await expect(items.nth(2)).toHaveClass(/outline-current/);
});

test("the outline grows while open when a new message is sent (US1 scenario 3)", async ({ page }) => {
  await sendAndWait(page, "first question");
  await sendAndWait(page, "second question");
  await page.getByTestId("outline-btn").click();
  await expect(page.getByTestId("outline-item")).toHaveCount(2);

  await sendAndWait(page, "third question");
  await expect(page.getByTestId("outline-item")).toHaveCount(3);
  await expect(page.getByTestId("outline-item").nth(2)).toContainText("third question");
});

test("the current marker follows scrolling (T005)", async ({ page }) => {
  for (let i = 1; i <= 6; i++) {
    await sendAndWait(page, `scroll marker question ${i}`);
  }
  await page.getByTestId("outline-btn").click();
  await expect(page.getByTestId("outline-item")).toHaveCount(6);
  // Jump to the last question; the marker must move there.
  await page.getByTestId("outline-item").nth(5).click();
  await expect(page.getByTestId("outline-item").nth(5)).toHaveClass(/outline-current/);
});

test("the outline panel stays inside the app at 360px with no horizontal overflow (FR-016)", async ({ page }) => {
  await sendAndWait(page, "geometry question one");
  await sendAndWait(page, "geometry question two");
  await page.setViewportSize({ width: 360, height: 760 });
  await page.getByTestId("outline-btn").click();

  const panel = page.getByTestId("session-outline");
  await expect(panel).toBeVisible();
  const pr = await panel.boundingBox();
  const app = page.locator(".app");
  const ar = await app.boundingBox();
  expect(pr).not.toBeNull();
  expect(ar).not.toBeNull();
  expect(pr!.x).toBeGreaterThanOrEqual(ar!.x - 0.5);
  expect(pr!.y).toBeGreaterThanOrEqual(ar!.y - 0.5);
  expect(pr!.x + pr!.width).toBeLessThanOrEqual(ar!.x + ar!.width + 0.5);
  expect(pr!.y + pr!.height).toBeLessThanOrEqual(ar!.y + ar!.height + 0.5);
  // Constitution II: no page-level horizontal scroll introduced by the panel.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});
