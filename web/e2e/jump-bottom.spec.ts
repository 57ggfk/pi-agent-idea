import { expect, test, type Page } from "@playwright/test";

/**
 * 029 — the "scroll to bottom" pill (specs/029-jump-to-bottom).
 *
 * The pill exists only while the pin machine (022) says "not following".
 * Every assertion here is numeric or count-based; the two geometry traps the
 * spec calls out are pinned by E1 (scrollHeight must not move when the button
 * appears) and E4 (the programmatic scroll must not be read as an upward
 * gesture, or the button would never disappear).
 */

const atBottom = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="message-list"]') as HTMLElement;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });

const metrics = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="message-list"]') as HTMLElement;
    return { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight };
  });

async function sendAndWait(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

async function seedTranscript(page: Page) {
  // The mock's replies carry markdown + tool cards — four rounds overflow
  // one screen (same seeding 022 used).
  for (let i = 1; i <= 4; i++) await sendAndWait(page, `round ${i}: fill the transcript past one screen`);
  await expect(page.getByTestId("item-user")).toHaveCount(4);
  // Sanity: the transcript must actually scroll, or the pill can never appear.
  const m = await metrics(page);
  expect(m.scrollHeight).toBeGreaterThan(m.clientHeight);
}

test("E1/US1: scrolls up → pill appears → click lands at the bottom, geometry unchanged", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await seedTranscript(page);

  // The pill never exists while pinned.
  await expect(page.getByTestId("jump-bottom")).toHaveCount(0);

  // Scroll to the top (a programmatic jump — but the pill's visibility is
  // derived from the pin machine, which reads it as... see E4: a plain
  // scrollTop write with unchanged height IS an inferred upward move).
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="message-list"]') as HTMLElement;
    el.scrollTop = 0;
  });
  await expect(page.getByTestId("jump-bottom")).toBeVisible({ timeout: 2_000 });

  const before = await metrics(page);
  await page.getByTestId("jump-bottom").click();

  await expect.poll(() => atBottom(page), { timeout: 3_000 }).toBeLessThanOrEqual(4);
  // The button is gone (not visibility-hidden — REMOVED, FR-003).
  await expect(page.getByTestId("jump-bottom")).toHaveCount(0);
  // FR-002: the button lives outside the scroll flow — inserting and removing
  // it must not move scrollHeight (the content-visibility lesson).
  const after = await metrics(page);
  expect(after.scrollHeight).toBe(before.scrollHeight);
  expect(await atBottom(page)).toBeLessThanOrEqual(4);
});

test("E2/US2: pinned + streaming keeps the pill unrendered for a whole second", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await seedTranscript(page);

  // Mid-stream (status busy) the view is pinned at the bottom — sample the
  // pill's existence repeatedly across a second of streaming.
  await page.getByTestId("composer-input").fill("stream while pinned");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });

  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    samples.push(await page.getByTestId("jump-bottom").count());
    await page.waitForTimeout(100);
  }
  expect(samples.every((n) => n === 0)).toBe(true);
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  expect(await page.getByTestId("jump-bottom").count()).toBe(0);
});

test("E3/US4: keyboard operable, aria-label localized", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await seedTranscript(page);

  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="message-list"]') as HTMLElement;
    el.scrollTop = 0;
  });
  const pill = page.getByTestId("jump-bottom");
  await expect(pill).toBeVisible({ timeout: 2_000 });
  const label = await pill.getAttribute("aria-label");
  expect(label === "Scroll to bottom" || label === "回到底部").toBe(true);

  // Tab-focusable by construction (<button>); Enter must trigger the jump.
  await pill.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => atBottom(page), { timeout: 3_000 }).toBeLessThanOrEqual(4);
  await expect(pill).toHaveCount(0);
});

test("E4/US5: the programmatic scroll re-pins — new content sticks again", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await seedTranscript(page);

  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="message-list"]') as HTMLElement;
    el.scrollTop = 0;
  });
  await page.getByTestId("jump-bottom").click();
  await expect.poll(() => atBottom(page), { timeout: 3_000 }).toBeLessThanOrEqual(4);

  // Two consecutive samples after the animation: the machine must stay
  // pinned (a smooth scroll misread as "up" would unpin here).
  await page.waitForTimeout(120);
  expect(await atBottom(page)).toBeLessThanOrEqual(4);
  await page.waitForTimeout(120);
  expect(await atBottom(page)).toBeLessThanOrEqual(4);

  // And new content still follows.
  await sendAndWait(page, "one more round after the jump");
  expect(await atBottom(page)).toBeLessThanOrEqual(4);
  await expect(page.getByTestId("jump-bottom")).toHaveCount(0);
});

test("E5/US3: new content while unpinned keeps the pill, does not drag the view", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await seedTranscript(page);

  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="message-list"]') as HTMLElement;
    el.scrollTop = 0;
  });
  await expect(page.getByTestId("jump-bottom")).toBeVisible({ timeout: 2_000 });
  const topBefore = (await metrics(page)).scrollTop;

  await sendAndWait(page, "new content while the user reads the top");
  // FR-008's observable half: the pill survives (and the future badge hook
  // flips), while the view stays where the user put it — 022's no-yank rule.
  await expect(page.getByTestId("jump-bottom")).toBeVisible();
  const topAfter = (await metrics(page)).scrollTop;
  expect(topAfter).toBeLessThan(topBefore + 4);
});
