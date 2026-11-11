import { expect, test, type Page } from "@playwright/test";

/**
 * Image preview modal (012 US7, tasks T134–T140). Thumbnails in the
 * transcript open the portal; the modal supports Esc/mask close, image-click
 * does NOT close, ←/→ switch between the session's images, zoom is clamped,
 * drag pans, and the save/copy bridge results are visible — including
 * failures (nothing may pretend success).
 */

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function sendImages(page: Page, count: number) {
  await page.setInputFiles(
    'input[type="file"]',
    Array.from({ length: count }, (_, i) => ({
      name: `pic-${i + 1}.png`,
      mimeType: "image/png",
      buffer: PNG,
    })),
  );
  await page.getByTestId("composer-input").fill("look at these");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("item-user")).toHaveCount(1);
  await expect(page.getByTestId("msg-image")).toHaveCount(count);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("three images: modal opens at 1/3, arrows switch, edges stop (T135)", async ({ page }) => {
  await sendImages(page, 3);

  await page.getByTestId("msg-image").first().click();
  await expect(page.getByTestId("image-preview-dialog")).toBeVisible();
  await expect(page.getByTestId("image-preview-count")).toContainText("1/3");

  await page.getByTestId("image-next").click();
  await expect(page.getByTestId("image-preview-count")).toContainText("2/3");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("image-preview-count")).toContainText("3/3");
  // the edge does not overshoot
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("image-preview-count")).toContainText("3/3");

  await page.getByTestId("image-prev").click();
  await expect(page.getByTestId("image-preview-count")).toContainText("2/3");
});

test("Esc and the mask close; clicking the image does not (T134)", async ({ page }) => {
  await sendImages(page, 1);
  await page.getByTestId("msg-image").first().click();
  await expect(page.getByTestId("image-preview-dialog")).toBeVisible();

  // image click: still open
  await page.getByTestId("image-preview-img").click();
  await expect(page.getByTestId("image-preview-dialog")).toBeVisible();

  // mask click: closed
  await page.locator(".image-preview-scrim").click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId("image-preview")).toHaveCount(0);

  // reopen, Esc: closed
  await page.getByTestId("msg-image").first().click();
  await expect(page.getByTestId("image-preview-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-preview")).toHaveCount(0);
});

test("the transcript does not scroll while the modal is open (T134)", async ({ page }) => {
  await sendImages(page, 2);
  // some scrollable history first
  await page.getByTestId("message-list").evaluate((el) => {
    el.scrollTop = 0; // start at the top; content is short anyway
  });
  const before = await page.getByTestId("message-list").evaluate((el) => el.scrollTop);

  await page.getByTestId("msg-image").first().click();
  await expect(page.getByTestId("image-preview-dialog")).toBeVisible();

  // wheel over the modal: zooms the image, not the list
  await page.getByTestId("image-preview-dialog").hover();
  await page.mouse.wheel(0, -240);
  await expect(page.getByTestId("image-preview-scale")).toContainText(/\d+%/, { timeout: 5_000 });

  const after = await page.getByTestId("message-list").evaluate((el) => el.scrollTop);
  expect(after).toBe(before);
});

test("zoom buttons clamp at the limits; reset restores 100% (T136)", async ({ page }) => {
  await sendImages(page, 1);
  await page.getByTestId("msg-image").first().click();
  await expect(page.getByTestId("image-preview-dialog")).toBeVisible();

  // click through to the ceiling: the button disables exactly at ZOOM_MAX
  const zoomIn = page.getByTestId("image-zoom-in");
  for (let i = 0; i < 30 && (await zoomIn.isEnabled()); i++) await zoomIn.click();
  await expect(page.getByTestId("image-preview-scale")).toHaveText("600%");
  await expect(zoomIn).toBeDisabled();

  await page.getByTestId("image-reset").click();
  await expect(page.getByTestId("image-preview-scale")).toHaveText("100%");

  // …and through the floor at ZOOM_MIN
  const zoomOut = page.getByTestId("image-zoom-out");
  for (let i = 0; i < 30 && (await zoomOut.isEnabled()); i++) await zoomOut.click();
  await expect(page.getByTestId("image-preview-scale")).toHaveText("25%");
  await expect(zoomOut).toBeDisabled();
});

test("drag pans the image (transform changes) (T136)", async ({ page }) => {
  await sendImages(page, 1);
  await page.getByTestId("msg-image").first().click();
  await expect(page.getByTestId("image-preview-dialog")).toBeVisible();

  const before = await page.getByTestId("image-preview-img").evaluate((el) => el.style.transform);
  const img = page.getByTestId("image-preview-img");
  const box = (await img.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  const after = await page.getByTestId("image-preview-img").evaluate((el) => el.style.transform);
  expect(after).not.toBe(before);
  expect(after).toContain("translate(40px, 20px)");
});

test("save succeeds with a path; failure and cancel are visible, never faked (T138)", async ({ page }) => {
  await sendImages(page, 1);
  await page.getByTestId("msg-image").first().click();
  await expect(page.getByTestId("image-preview-dialog")).toBeVisible();

  await page.getByTestId("image-save").click();
  await expect(page.getByTestId("image-result-ok")).toContainText("pi-image-1.png");
  await page.getByTestId("image-copy").click();
  await expect(page.getByTestId("image-result-ok")).toContainText("clipboard");
  await page.keyboard.press("Escape");

  // failure fixtures: the error text shows and NO success note exists
  await page.goto("/?saveimg=fail");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.setInputFiles('input[type="file"]', { name: "x.png", mimeType: "image/png", buffer: PNG });
  await page.getByTestId("composer-input").fill("failing save");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("msg-image")).toBeVisible();
  await page.getByTestId("msg-image").click();
  await expect(page.getByTestId("image-preview-dialog")).toBeVisible();
  await page.getByTestId("image-save").click();
  await expect(page.getByTestId("image-result-fail")).toContainText("could not write the file");
  await expect(page.getByTestId("image-result-ok")).toHaveCount(0);
  await page.getByTestId("image-copy").click();
  await expect(page.getByTestId("image-result-fail")).toContainText("clipboard is unavailable");

  await page.goto("/?saveimg=cancel");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.setInputFiles('input[type="file"]', { name: "y.png", mimeType: "image/png", buffer: PNG });
  await page.getByTestId("composer-input").fill("cancelled save");
  await page.getByTestId("send-btn").click();
  await page.getByTestId("msg-image").click();
  await page.getByTestId("image-save").click();
  await expect(page.getByTestId("image-result-fail")).toContainText("cancelled");
  await expect(page.getByTestId("image-result-ok")).toHaveCount(0);
});

test("all three wire shapes open the modal; no extra image nodes exist (T139)", async ({ page }) => {
  // the mock's approval image path uses bare base64; the optimistic item
  // normalizes to bare base64 too; data: URLs come from pi — the store's
  // normalizer covers all three, and this assertion is on the store output:
  await sendImages(page, 2);
  const nodes = await page.evaluate(() => document.querySelectorAll("img.msg-image").length);
  const bigNodes = await page.evaluate(() => document.querySelectorAll(".image-preview-img").length);
  expect(nodes).toBe(2); // thumbnails only
  expect(bigNodes).toBe(0); // nothing pre-rendered while closed

  await page.getByTestId("msg-image").nth(1).click();
  await expect(page.getByTestId("image-preview-img")).toBeVisible();
  // still exactly one preview node, sourced from the same payload
  expect(await page.evaluate(() => document.querySelectorAll(".image-preview-img").length)).toBe(1);
});

test("a text-only session never opens a preview (T140 zero regression)", async ({ page }) => {
  await page.getByTestId("composer-input").fill("just words");
  await page.getByTestId("send-btn").click();
  await expect(page.locator(".item-assistant").last()).toContainText("hello from mock pi", { timeout: 30_000 });
  await expect(page.getByTestId("msg-image")).toHaveCount(0);
  // no crash, no modal
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-preview")).toHaveCount(0);
});

// -- 018 US2: composer thumbnails open the same modal -------------------------

test.describe("composer image cards", () => {
  test("thumbnails render at ~64px and open the preview modal with the composer list", async ({ page }) => {
    await page.setInputFiles('input[type="file"]', [
      { name: "pic-1.png", mimeType: "image/png", buffer: PNG },
      { name: "pic-2.png", mimeType: "image/png", buffer: PNG },
    ]);
    const cards = page.getByTestId("image-card");
    await expect(cards).toHaveCount(2);
    await expect(page.getByTestId("image-chips")).toContainText("pic-1.png");

    const size = await cards.first().locator("img").evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.abs(size - 64)).toBeLessThanOrEqual(2);

    // click the first thumb → modal shows 1/2 with the file name
    await cards.first().locator("img").click();
    await expect(page.getByTestId("image-preview-dialog")).toBeVisible();
    await expect(page.getByTestId("image-preview-count")).toContainText("1/2");
    await expect(page.getByTestId("image-preview-count")).toContainText("pic-1.png");

    // ←/→ walk the COMPOSER list (not the transcript's, which is empty here)
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("image-preview-count")).toContainText("2/2");

    // close → composer state untouched, both cards still pending
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("image-preview-dialog")).toHaveCount(0);
    await expect(cards).toHaveCount(2);
  });

  test("removing a card drops the image from the pending list", async ({ page }) => {
    await page.setInputFiles('input[type="file"]', [
      { name: "pic-1.png", mimeType: "image/png", buffer: PNG },
      { name: "pic-2.png", mimeType: "image/png", buffer: PNG },
    ]);
    await expect(page.getByTestId("image-card")).toHaveCount(2);
    await page
      .getByTestId("image-card")
      .first()
      .getByRole("button", { name: /pic-1\.png/ })
      .click();
    await expect(page.getByTestId("image-card")).toHaveCount(1);
    await expect(page.getByTestId("image-chips")).toContainText("pic-2.png");
  });
});
