import { expect, test } from "@playwright/test";

/**
 * The UI runs inside an IDE tool window that users drag as narrow as they like,
 * so the page itself must never grow a horizontal scrollbar. Inner code blocks
 * may scroll on their own, and below 480px even those wrap.
 */
const WIDTHS = [360, 420, 520, 640, 720, 900];

/** Document-level horizontal overflow, the send cluster position and the
 *  composer control-row height (58px == the row wrapped onto two lines). */
const measure = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    const split = document.querySelector(".split-btn");
    const controls = document.querySelector(".composer-controls");
    return {
      overflow: Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
      sendRight: split ? Math.round(split.getBoundingClientRect().right) : 0,
      controlsHeight: controls ? Math.round(controls.getBoundingClientRect().height) : 0,
      viewport: root.clientWidth,
    };
  });

for (const width of WIDTHS) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/");
    await expect(page.getByTestId("composer-input")).toBeVisible();

    let m = await measure(page);
    expect(m.overflow, `document overflows at ${width}px (empty state)`).toBeLessThanOrEqual(0);
    expect(m.sendRight, `send button past the edge at ${width}px`).toBeLessThanOrEqual(m.viewport);
    expect(m.controlsHeight, `control row wrapped at ${width}px`).toBeLessThanOrEqual(30);

    // Same check with a busy conversation: tool card, diff preview, long text.
    await page.getByTestId("composer-input").fill("Fix the failing tests and show the diff");
    await page.getByTestId("send-btn").click();
    await expect(page.locator(".tool-card").first()).toBeVisible({ timeout: 15_000 });

    m = await measure(page);
    expect(m.overflow, `document overflows at ${width}px (busy)`).toBeLessThanOrEqual(0);
    expect(m.sendRight, `send button past the edge at ${width}px (busy)`).toBeLessThanOrEqual(
      m.viewport,
    );
  });
}

test("extreme 320px window still has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeVisible();

  const m = await measure(page);
  expect(m.overflow).toBeLessThanOrEqual(0);
  expect(m.sendRight).toBeLessThanOrEqual(m.viewport);
});

test("pickers collapse to icons when the window is narrow", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 760 });
  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeVisible();

  const modelLabel = page.getByTestId("model-chip").locator(".chip-label");
  const thinkingLabel = page.getByTestId("thinking-select").locator(".chip-label");

  // Density is measured from real text widths, so the exact collapse width
  // moves with platform fonts (CI Linux still fits at 420px where macOS
  // collapses). Shrink until the app's own state reaches tier 2 instead of
  // assuming one width works everywhere.
  let collapsed = -1;
  for (let w = 420; w >= 300 && collapsed < 0; w -= 20) {
    await page.setViewportSize({ width: w, height: 760 });
    try {
      await expect(page.locator(".composer-controls")).toHaveAttribute("data-density", "2", { timeout: 1_000 });
      collapsed = w;
    } catch { /* not yet — keep shrinking */ }
  }
  expect(collapsed).toBeGreaterThanOrEqual(0);
  await expect(modelLabel).toBeHidden();
  await expect(thinkingLabel).toBeHidden();

  // The selection stays discoverable through the in-app tooltip (012 US2:
  // data-tip replaced the native title — JCEF does not guarantee those).
  await expect(page.getByTestId("model-chip")).toHaveAttribute("data-tip", /Mock Model Pro/);
  await expect(page.getByTestId("thinking-select")).toHaveAttribute(
    "data-tip",
    /medium/,
  );

  // Wide tool window: labels are back.
  await page.setViewportSize({ width: 900, height: 760 });
  await expect(modelLabel).toBeVisible();
  await expect(thinkingLabel).toHaveText("medium");
});

/**
 * A label is always dropped before the row is allowed to wrap: the row's real
 * width need depends on the model name (real ones are far longer than the
 * mock's), not on the window width alone. Regression guard for the report where
 * "Free Models Router" pushed the action buttons onto a second line.
 */
test("a long model name tightens the row instead of wrapping it", async ({ page }) => {
  for (const width of [480, 560, 620, 680]) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/");
    await expect(page.getByTestId("composer-input")).toBeVisible();

    await page.evaluate(() => {
      const label = document.querySelector('[data-testid="model-chip"] .chip-label');
      if (label) label.textContent = "Free Models Router";
    });
    await expect
      .poll(() => measure(page).then((m) => m.controlsHeight))
      .toBeLessThanOrEqual(30);

    const m = await measure(page);
    expect(m.overflow, `document overflows at ${width}px with a long model name`).toBeLessThanOrEqual(0);
    expect(m.sendRight, `send button past the edge at ${width}px`).toBeLessThanOrEqual(m.viewport);
  }
});

