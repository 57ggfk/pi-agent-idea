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
  const btn = page.locator(".markdown pre .copy-image-btn").first();
  await expect(btn).toBeVisible({ timeout: 30_000 });
  await btn.click();
  await expect(btn).toHaveText("✓");
  // The rasterize→bridge round trip is async — poll for the echo.
  await expect.poll(() => mockEcho(page)).toMatch(/^data:image\/png;base64,/);
});

test("bare inline SVG gets the button (047 US2)", async ({ page }) => {
  await send(page, "svg");
  // The legal bare SVG (outside any pre) — wrapped with the button.
  const legal = page.locator(".markdown svg circle[r='8']").first();
  const frame = legal.locator("xpath=ancestor::span[@class='copyable-frame'][1]");
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
  await btn.click();
  await expect(btn).toHaveText("✗");
  // The label is locale-dependent (the e2e browser runs with en-US).
  await expect(btn).toHaveText(/复制为图片|Copy as image/, { timeout: 3000 });
});

test("degraded and code blocks carry no copy-as-image entry (047 FR-007)", async ({ page }) => {
  await send(page, "svg");
  // Both fenced svg source blocks stay code blocks: only Copy + Open in IDE.
  const preButtons = page.locator(".markdown pre .copy-image-btn");
  await expect(preButtons).toHaveCount(0);
  await expect(page.locator(".markdown pre .code-copy-btn")).toHaveCount(2);
  // The malicious bare SVG is stripped down to a rect — still an svg element,
  // so it keeps the entry (it renders something); the malformed one renders
  // no svg element at all, so no frame wraps it.
  await expect(page.locator(".copyable-frame")).toHaveCount(2);
});
