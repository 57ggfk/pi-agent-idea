import { expect, test, type Locator, type Page } from "@playwright/test";
import { WHEEL_GAIN } from "../src/lib/wheel";

/**
 * Wheel response (`lib/wheel.ts`).
 *
 * The measurement that drove this (real detents into the JCEF panel, see
 * `web/probe-wheel-scale.mjs`) said the notch already moves 100px — as much as
 * a browser — but spreads it over ~190ms. So the assertions here are about
 * *when* the pixels land, not how many: a notch must be complete in a frame.
 * If someone later "fixes" this by multiplying the distance, the first test
 * still passes and the total assertion catches it.
 *
 * Three more things can regress independently, one test each: upward gestures
 * get the same treatment; at an edge the gesture goes back to the browser
 * (022's chaining fix depends on that); and an open modal keeps the page
 * behind it still — a capture-phase listener runs *before* the dialog's own
 * React `preventDefault`, so this is a real risk, not a theoretical one.
 */

/** What one detent looks like from inside the page (measured, not assumed). */
const NOTCH = 100;

const top = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="message-list"]')!.scrollTop);

async function center(el: Locator): Promise<{ x: number; y: number }> {
  const box = await el.boundingBox();
  if (!box) throw new Error("element has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Enough transcript that 400px in has headroom in both directions. */
async function seed(page: Page) {
  for (let i = 0; i < 6; i++) {
    await page.getByTestId("composer-input").fill(`line ${i} — 让记录足够长，好让滚轮有空间可走`);
    await page.getByTestId("send-btn").click();
    await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
    await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  }
}

async function park(page: Page, at: "middle" | "bottom") {
  await page.evaluate((where) => {
    const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!;
    el.scrollTop = where === "bottom" ? el.scrollHeight : 400;
  }, at);
}

/** Records whether each gesture was consumed by the takeover. */
async function watchGestures(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __gestures: { dy: number; prevented: boolean }[] }).__gestures = [];
    addEventListener(
      "wheel",
      (e) =>
        (window as unknown as { __gestures: { dy: number; prevented: boolean }[] }).__gestures.push({
          dy: e.deltaY,
          prevented: e.defaultPrevented,
        }),
      { passive: true },
    );
  });
  return () => page.evaluate(() => (window as unknown as { __gestures: { dy: number; prevented: boolean }[] }).__gestures);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("one notch lands in a frame, at the browser's own distance", async ({ page }) => {
  await seed(page);
  await park(page, "middle");
  const list = page.getByTestId("message-list");
  const point = await center(list);
  await page.mouse.move(point.x, point.y);

  const before = await top(page);
  await page.mouse.wheel(0, NOTCH);
  // 30ms in, an animated notch has travelled ~6px (measured). A takeover has
  // already finished, so anything past half the notch proves it.
  await page.waitForTimeout(30);
  const early = (await top(page)) - before;
  expect(early).toBeGreaterThanOrEqual(NOTCH / 2);

  await page.waitForTimeout(400);
  const total = (await top(page)) - before;
  expect(Math.abs(total - NOTCH * WHEEL_GAIN)).toBeLessThanOrEqual(2);
});

test("upward notches get the same instant treatment", async ({ page }) => {
  await seed(page);
  await park(page, "middle");
  const list = page.getByTestId("message-list");
  const point = await center(list);
  await page.mouse.move(point.x, point.y);

  const before = await top(page);
  await page.mouse.wheel(0, -NOTCH);
  await page.waitForTimeout(30);
  expect(before - (await top(page))).toBeGreaterThanOrEqual(NOTCH / 2);
});

test("only detents are taken over; a trackpad dribble stays native", async ({ page }) => {
  await seed(page);
  await park(page, "middle");
  const list = page.getByTestId("message-list");
  const point = await center(list);
  await page.mouse.move(point.x, point.y);
  const gestures = await watchGestures(page);

  await page.mouse.wheel(0, NOTCH);
  await page.waitForTimeout(250);
  await page.mouse.wheel(0, 12);
  await page.waitForTimeout(250);

  const seen = await gestures();
  expect(seen).toHaveLength(2);
  expect(seen[0].prevented, "a detent is consumed by the takeover").toBe(true);
  expect(seen[1].prevented, "a 12px dribble keeps the browser's smoothing").toBe(false);
});

test("at the bottom the extra notch is left to the browser, not swallowed", async ({ page }) => {
  await seed(page);
  await park(page, "bottom");
  const list = page.getByTestId("message-list");
  const point = await center(list);
  await page.mouse.move(point.x, point.y);

  const atBottom = await top(page);
  await page.mouse.wheel(0, NOTCH);
  await page.waitForTimeout(120);
  // Clamped exactly where it was — no jump, no scroll lost out of the list.
  expect(Math.abs((await top(page)) - atBottom)).toBeLessThanOrEqual(1);

  // And the next upward notch is not latched: it moves immediately (022).
  await page.mouse.wheel(0, -NOTCH);
  await expect.poll(() => top(page), { timeout: 1000 }).toBeLessThan(atBottom - NOTCH / 2);
});

test("an open modal keeps the transcript still", async ({ page }) => {
  await seed(page);
  await park(page, "middle");
  const before = await top(page);

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  const scrim = page.getByTestId("confirm-scrim");
  const point = await center(scrim);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(150);

  expect(await top(page)).toBe(before);
});
