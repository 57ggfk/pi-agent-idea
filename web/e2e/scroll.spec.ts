import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * 022 — scroll interaction (specs/022-scroll-jank).
 *
 * Two separate symptoms, one file:
 * - the picker used to re-render every row on `mouseenter` and then force a
 *   layout, so a wheel notch queued behind React and the list "would not move
 *   until you stopped";
 * - the transcript treated "within 60px of the bottom" as "follow new
 *   content", a threshold a single wheel notch crosses.
 */

async function sendAndWait(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

async function center(el: Locator): Promise<{ x: number; y: number }> {
  const box = await el.boundingBox();
  if (!box) throw new Error("element has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const scrollTop = (page: Page, selector: string) =>
  page.evaluate((sel) => document.querySelector(sel)?.scrollTop ?? 0, selector);

test.describe("model picker scrolling", () => {
  test("a wheel notch right at the bottom moves the list immediately", async ({ page }) => {
    await page.goto("/?models=now");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("model-chip").click();
    const list = page.locator(".model-list");
    await expect(list).toBeVisible();

    // Park at the very bottom, then scroll up one notch without pausing.
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const before = await scrollTop(page, ".model-list");
    expect(before).toBeGreaterThan(0);

    const point = await center(list);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -120);

    await expect.poll(() => scrollTop(page, ".model-list"), { timeout: 1000 }).toBeLessThan(before);
  });

  test("hovering moves no highlight and renders no rows", async ({ page }) => {
    await page.goto("/?models=now");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("model-chip").click();
    await expect(page.getByTestId("model-option").first()).toBeVisible();

    type Probe = { hoverRenders: () => number; resetHoverRenders: () => void };
    await page.evaluate(() => {
      (window as unknown as { __piPerf: Probe }).__piPerf.resetHoverRenders();
    });

    const options = page.getByTestId("model-option");
    const first = options.nth(0);
    await expect(first).toHaveAttribute("data-active", "true"); // open-locate highlight

    const target = options.nth(4);
    await target.hover();

    // data-active means "keyboard current item" since 022 — hovering row 5
    // must not steal it from row 1.
    await expect(target).toHaveAttribute("data-active", "false");
    await expect(first).toHaveAttribute("data-active", "true");

    // …and nothing re-rendered: no state was written.
    const rendered = await page.evaluate(() =>
      (window as unknown as { __piPerf: Probe }).__piPerf.hoverRenders(),
    );
    expect(rendered).toBe(0);
  });

  test("Enter after hovering picks the hovered row", async ({ page }) => {
    await page.goto("/?models=now");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("model-chip").click();
    const options = page.getByTestId("model-option");
    await expect(options.first()).toBeVisible();

    const target = options.nth(4);
    const label = (await target.locator(".model-option-name").innerText()).trim();
    await target.hover();
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("model-popover")).toHaveCount(0);
    await expect(page.getByTestId("model-chip")).toContainText(label);
  });

  test("hovering never scrolls the list", async ({ page }) => {
    await page.goto("/?models=now");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("model-chip").click();
    const list = page.locator(".model-list");
    await expect(page.getByTestId("model-option").first()).toBeVisible();

    // Anchor the scroll position somewhere in the middle, then sweep the
    // pointer down over the rows: 022 keeps the wheel in charge of scrolling.
    // (Locator.hover() would scroll the target into view itself, so this
    // gestures with raw coordinates instead.)
    await list.evaluate((el) => {
      el.scrollTop = 400;
    });
    const before = await scrollTop(page, ".model-list");
    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 20);
    for (let dy = 20; dy < Math.min(200, box.height); dy += 25) {
      await page.mouse.move(box.x + box.width / 2, box.y + dy);
    }
    expect(await scrollTop(page, ".model-list")).toBe(before);
  });
});

test.describe("transcript scrolling", () => {
  test.setTimeout(180_000);

  /** Four rounds at 400px height overflow the viewport comfortably. */
  async function seed(page: Page) {
    await page.setViewportSize({ width: 680, height: 400 });
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    for (let i = 1; i <= 4; i++) await sendAndWait(page, `第 ${i} 条消息，用来把内容撑出一屏`);
    await expect(page.getByTestId("item-user")).toHaveCount(4);
  }

  test("scrolling up from the bottom works on the first notch", async ({ page }) => {
    await seed(page);
    const list = page.getByTestId("message-list");
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const before = await scrollTop(page, '[data-testid="message-list"]');

    const point = await center(list);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -120);

    // The old distance rule kept the view pinned and pulled it back on the
    // next update; the direction rule releases it immediately.
    await expect
      .poll(() => scrollTop(page, '[data-testid="message-list"]'), { timeout: 1000 })
      .toBeLessThan(before);
  });

  test("a new message does not yank an unpinned view back to the bottom", async ({ page }) => {
    await seed(page);
    const list = page.getByTestId("message-list");
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const before = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!;
      return { max: el.scrollHeight - el.clientHeight };
    });
    const point = await center(list);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -240);
    // Wait for the gesture to actually land before parking the assertion.
    await expect
      .poll(() => scrollTop(page, '[data-testid="message-list"]'), { timeout: 1000 })
      .toBeLessThan(before.max - 100);

    await sendAndWait(page, "new content while scrolled up");

    const after = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!;
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
    });
    // Not at the bottom: the new content must not pull the view down.
    expect(after.top).toBeLessThan(after.max - 100);
  });

  test("a pinned view keeps following new messages", async ({ page }) => {
    await seed(page);
    const list = page.getByTestId("message-list");
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    // A real gesture at the bottom re-pins the view.
    const point = await center(list);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 120);

    await sendAndWait(page, "follow this");

    const { top, max } = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!;
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
    });
    expect(top).toBeGreaterThanOrEqual(max - 4);
  });
});
