import { test, expect } from "@playwright/test";

/**
 * App-wide tooltip (012 US2, tasks T110–T114). The bubble is one delegated
 * layer for every [data-tip]: hover and focus both trigger, the bubble stays
 * inside the viewport, the click target keeps working, Esc dismisses, and a
 * confirm dialog never gets covered (z-index 30 under the scrim's 40).
 */

const BUBBLE = ".tooltip";

test("hovering an icon button shows the bubble; the click still works (T110)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  const chip = page.getByTestId("model-chip");
  await chip.hover();
  await expect(page.locator(BUBBLE)).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(BUBBLE)).toContainText("Mock Model Pro");

  // the bubble never swallows the click: the chip still toggles the picker
  await chip.click();
  await expect(page.getByTestId("model-popover")).toBeVisible();
  // a pointerdown dismissed the bubble; the popover is open instead
  await expect(page.locator(BUBBLE)).toBeHidden();
});

test("focus triggers the bubble; Esc dismisses it (T110)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await page.getByTestId("model-chip").focus();
  await expect(page.locator(BUBBLE)).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator(BUBBLE)).toBeHidden();
});

test("the bubble stays inside the viewport for edge anchors (T110)", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 700 });
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  // the options button sits in the bottom row — the bubble must flip above
  const btn = page.getByTestId("options-btn");
  await btn.hover();
  await expect(page.locator(BUBBLE)).toBeVisible({ timeout: 5_000 });
  await expect.poll(async () => btn.getAttribute("data-tip")).toBeTruthy();

  const inside = await page.evaluate(() => {
    const el = document.querySelector(".tooltip")!;
    const r = el.getBoundingClientRect();
    return (
      r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight
    );
  });
  expect(inside).toBe(true);
});

test("density-collapsed pickers surface the current value (T112)", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 760 });
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  // labels are hidden at this width (density tier 2)
  await expect(page.getByTestId("model-chip").locator(".chip-label")).toBeHidden();

  await page.getByTestId("model-chip").hover();
  await expect(page.locator(BUBBLE)).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(BUBBLE)).toContainText("Mock Model Pro");
  await expect(page.locator(BUBBLE)).toContainText("mock/");

  await page.getByTestId("thinking-select").hover();
  await expect(page.locator(BUBBLE)).toContainText("medium", { timeout: 5_000 });
});

test("a confirm dialog is never covered by the tooltip (T114)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  // 007: an empty session quits without a dialog — give it content first
  await page.getByTestId("composer-input").fill("seed content");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("abort-btn")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("abort-btn")).toHaveCount(0, { timeout: 30_000 });

  // open the new-session confirm dialog
  await page.getByTestId("new-session").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();

  // hover a dialog button that carries a tip: the bubble may show, but the
  // dialog stays on top (z-index) and keeps focus
  const cancel = page.getByTestId("confirm-cancel");
  await cancel.hover();
  await expect(dialog).toBeVisible();
  // Esc belongs to the dialog (closes it), not to a tooltip underneath
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("manage panels show no hardcoded English in zh (T113)", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await expect(page.getByTestId("manage-view")).toBeVisible();

  await page.getByTestId("manage-tab-auth").click();
  await expect(page.getByTestId("auth-refresh")).toHaveText("刷新");
  // the auth hint line no longer carries the raw English sentence
  await expect(page.getByTestId("auth-panel")).toContainText("pi auth check");
  await expect(page.getByTestId("auth-panel")).not.toContainText("Checks run `pi auth check");

  await page.getByTestId("manage-tab-packages").click();
  await expect(page.getByTestId("package-install")).toHaveText("安装");
  await expect(page.getByTestId("packages-refresh")).toHaveText("刷新");
});
