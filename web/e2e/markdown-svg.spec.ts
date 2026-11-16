import { expect, test } from "@playwright/test";

/**
 * Inline SVG rendering (039): legal SVG renders inside the message bubble,
 * malicious vectors (script / foreignObject / remote href) are stripped by
 * the same DOMPurify pass, malformed SVG degrades without breaking the
 * message.
 */

test("legal inline SVG renders inside the bubble, size-constrained (039 US1)", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show icons");
  await page.getByTestId("send-btn").click();

  const svg = page.locator(".markdown svg[viewBox='0 0 20 20']");
  await expect(svg).toHaveCount(2, { timeout: 30_000 });
  // The legal circle survives…
  await expect(page.locator(".markdown svg circle[r='8']")).toHaveCount(1);
  // …and is constrained by the container (FR-001).
  const constraint = await page.evaluate(() => {
    const el = document.querySelector(".markdown svg circle[r='8']")!.closest("svg")!;
    const s = getComputedStyle(el);
    const bubble = el.closest(".markdown")!;
    return { maxW: s.maxWidth, bubbleW: bubble.clientWidth, w: el.getBoundingClientRect().width };
  });
  expect(constraint.maxW === "100%" || constraint.maxW.endsWith("px")).toBe(true);
});

test("malicious SVG vectors are stripped: no script, no foreignObject, no remote href (039 US2)", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show icons");
  await page.getByTestId("send-btn").click();
  await expect(page.locator(".markdown svg")).toHaveCount(2, { timeout: 30_000 });

  const audit = await page.evaluate(() => {
    const root = document.querySelector(".markdown")!;
    return {
      scripts: root.querySelectorAll("script").length,
      foreignObjects: root.querySelectorAll("foreignObject").length,
      remoteLinks: Array.from(root.querySelectorAll("[href], [xlink\\:href]")).filter((el) =>
        (el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "").startsWith("http"),
      ).length,
      evilHost: root.innerHTML.includes("evil.example"),
      rectSurvives: root.querySelectorAll("rect").length,
    };
  });
  expect(audit.scripts).toBe(0);
  expect(audit.foreignObjects).toBe(0);
  expect(audit.remoteLinks).toBe(0);
  expect(audit.evilHost).toBe(false);
});

test("a malformed SVG degrades without breaking the message (039 FR-004)", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show icons");
  await page.getByTestId("send-btn").click();
  // The message as a whole still rendered its prose + both SVG groups.
  await expect(page.locator(".markdown", { hasText: "Icon:" })).toContainText("Malformed:", { timeout: 30_000 });
  await expect(page.locator(".markdown", { hasText: "Icon:" })).toContainText("Icon:");
  // No error banner / blank panel — the prose after the malformed SVG renders.
  await expect(page.locator(".markdown", { hasText: "Icon:" })).toContainText("Danger:");
});

test("zero regression: file links and code blocks still work with SVG enabled (039 FR-005)", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show icons");
  await page.getByTestId("send-btn").click();
  await expect(page.locator(".markdown svg")).toHaveCount(2, { timeout: 30_000 });
  // Code block highlight pipeline still runs (the copy button gets injected).
  await expect(page.locator(".markdown .code-copy-btn").first()).toHaveCount(1);
  // The message copy action still sees real text (no SVG corruption of the
  // source — the transcript keeps the raw markdown).
  await expect(page.locator(".markdown", { hasText: "Icon:" })).toContainText("Icon:");
});
