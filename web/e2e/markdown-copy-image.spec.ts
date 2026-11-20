import { expect, test } from "@playwright/test";

/**
 * 047: the graphic render blocks (SVG / Mermaid figure / KaTeX display) carry
 * a hover 「复制为图片」 button. The click rasterizes the sanitized rendered
 * DOM into a PNG data URL and hands it to `ide.copyImage` — the 012 bridge is
 * the machine-verified channel (Q3). Downgraded blocks get no entry (FR-007),
 * and code blocks keep their Copy / Open-in-IDE pair only.
 */

const mockEcho = (page: import("@playwright/test").Page) =>
  page.evaluate(() => sessionStorage.getItem("pi-mock-copy-image"));

async function send(page: import("@playwright/test").Page, md: string, query = "") {
  await page.goto(`/?md=${md}${query ? `&${query}` : ""}`);
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("draw it");
  await page.getByTestId("send-btn").click();
}

test("mermaid figure gets the button on the shared action bar; click hands a PNG (047 US1)", async ({ page }) => {
  await send(page, "mermaid");
  // Settle the WHOLE stream first (status-dot busy → idle): the trailing
  // message_update events still wipe .markdown and swallow clicks.
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  // A stale streaming-prefix figure can briefly coexist (040's known
  // transient); any figure-bearing pre carries the button — click the first.
  // The button rides the block's action bar, which lives in the shell (the
  // bar sits outside the block, above its top-right corner).
  const btn = page.locator(".markdown .block-shell .copy-image-btn").first();
  await expect(btn).toBeVisible({ timeout: 30_000 });
  await page.locator(".markdown .block-shell").first().hover();
  await btn.click();
  await expect(btn).toHaveText("✓");
  // The rasterize→bridge round trip is async — poll for the echo.
  await expect.poll(() => mockEcho(page)).toMatch(/^data:image\/png;base64,/);
});

test("bare inline SVG gets the button (047 US2)", async ({ page }) => {
  await send(page, "svg");
  // Settle the stream first: React rebuilds the whole .markdown HTML on every
  // delta, so a block that is still being replaced is detached again before
  // the pointer can settle on it — the hover would never become stable.
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  // The legal bare SVG (outside any pre) — wrapped with the button.
  const legal = page.locator(".markdown svg circle[r='8']").first();
  const frame = legal.locator("xpath=ancestor::span[contains(@class,'copyable-frame')][1]");
  await expect(frame).toHaveCount(1);
  const btn = frame.locator("[data-testid='copy-image-btn']");
  await expect(btn).toHaveCount(1);
  await frame.hover();
  await btn.click();
  await expect.poll(() => mockEcho(page)).toMatch(/^data:image\/png;base64,/);
});

test("KaTeX display block gets the button (047 US3)", async ({ page }) => {
  await send(page, "math");
  // Settle before interacting: streaming re-renders move the wrapped block.
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  const display = page.locator(".katex-display").first();
  await expect(display).toHaveCount(1);
  const btn = page.locator(".copyable-frame:has(.katex-display) [data-testid='copy-image-btn']").first();
  await expect(btn).toBeVisible({ timeout: 10_000 });
  await display.hover();
  await btn.click();
  await expect(btn).toHaveText("✓");
  await expect.poll(() => mockEcho(page)).toMatch(/^data:image\/png;base64,/);
});

test("a failed copy flashes ✗ and recovers (047 US4/FR-005)", async ({ page }) => {
  await send(page, "math", "copyimg=fail");
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  const display = page.locator(".katex-display").first();
  await expect(display).toHaveCount(1);
  const btn = page.locator(".copyable-frame:has(.katex-display) [data-testid='copy-image-btn']").first();
  // The bar is hover-only (pointer-events off while hidden) — hover the
  // block first, exactly like a user.
  await display.hover();
  await btn.click();
  await expect(btn).toHaveText("✗");
  // The label is locale-dependent (the e2e browser runs with en-US).
  await expect(btn).toHaveText(/复制为图片|Copy as image/, { timeout: 3000 });
});

test("degraded blocks carry no copy-as-image entry (047 FR-007)", async ({ page }) => {
  await send(page, "svg");
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  // 048: a ```svg fence renders as a graphic → it DOES get the entry now.
  const rendered = page.locator(".markdown .block-shell", { has: page.locator(".svg-figure") });
  await expect(rendered).toHaveCount(1);
  await expect(rendered.locator(".copy-image-btn")).toHaveCount(1);
  // The fenced malicious sample paints nothing → it degrades to its source
  // and keeps no entry (047 FR-007), but the source is still copyable.
  const degraded = page.locator(".markdown .block-shell", {
    has: page.locator("code.language-svg", { hasText: "alert(1)" }),
  });
  await expect(degraded).toHaveCount(1);
  await expect(degraded.locator(".copy-image-btn")).toHaveCount(0);
  await expect(degraded.locator(".code-copy-btn")).toHaveCount(1);
  // The malicious bare SVG is stripped down to a rect — still an svg element,
  // so it keeps the entry (it renders something); the malformed one renders
  // no svg element at all, so no frame wraps it.
  await expect(page.locator(".copyable-frame")).toHaveCount(2);
});
