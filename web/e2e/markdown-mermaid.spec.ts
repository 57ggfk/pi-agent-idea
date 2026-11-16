import { expect, test } from "@playwright/test";

/**
 * Mermaid diagram rendering (040 US2): ```mermaid blocks render as diagrams
 * inside the message; a syntax-error block degrades to its source code; the
 * pipeline stays inside the DOMPurify-sanitized world (FR-005) and the
 * diagram is size-constrained (FR-003).
 */

const reply = (page: import("@playwright/test").Page) =>
  page.locator(".markdown", { hasText: "Valid:" });

async function sendMermaidReply(page: import("@playwright/test").Page) {
  await page.goto("/?md=mermaid");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("draw it");
  await page.getByTestId("send-btn").click();
  await expect(reply(page)).toContainText("Valid:", { timeout: 30_000 });
  // Settled: the broken block's source (end of the reply) has arrived.
  await expect(reply(page)).toContainText("Broken:", { timeout: 30_000 });
  // mermaid loads lazily and renders async; streaming re-renders make the
  // figure tree transient — count with retry instead of a point-in-time check.
  await expect(reply(page).locator(".mermaid-figure svg")).toHaveCount(1, { timeout: 30_000 });
}

test("a valid mermaid block renders as a diagram (040 US2)", async ({ page }) => {
  await sendMermaidReply(page);
  const fig = reply(page).locator(".mermaid-figure svg");
  await expect(fig).toHaveCount(1);
  // The diagram keeps its labels (svg text nodes, htmlLabels off or on).
  const label = await fig.evaluate((el) => (el.textContent || "").includes("Start"));
  expect(label).toBe(true);
  // Size-constrained to the bubble (FR-003).
  const w = await fig.evaluate((el) => {
    const s = getComputedStyle(el);
    return { maxW: s.maxWidth, w: el.getBoundingClientRect().width, bubble: el.closest(".markdown")!.clientWidth };
  });
  expect(w.w).toBeLessThanOrEqual(w.bubble);
});

test("a broken mermaid block degrades to its source code (040 FR-004)", async ({ page }) => {
  await sendMermaidReply(page);
  // The broken block keeps its visible source code (no figure replaced it).
  const broken = reply(page).locator("pre").filter({
    has: page.locator("code.language-mermaid", { hasText: "A --> ];" }),
  });
  await expect(broken).toHaveCount(1);
  await expect(broken.locator(".mermaid-figure")).toHaveCount(0);
  const visible = await broken.locator("code.language-mermaid").evaluate((el) => getComputedStyle(el).display);
  expect(visible).not.toBe("none");
});

test("mermaid output is sanitized: no script, no inline handlers (040 FR-002/FR-005)", async ({ page }) => {
  await sendMermaidReply(page);
  const audit = await reply(page).evaluate((el) => ({
    scripts: el.querySelectorAll("script").length,
    onEvents: el.querySelectorAll("[onclick], [onload], [onerror]").length,
    figures: el.querySelectorAll(".mermaid-figure svg").length,
  }));
  expect(audit.scripts).toBe(0);
  expect(audit.onEvents).toBe(0);
  expect(audit.figures).toBe(1);
});

test("zero regression: the copy button still works on the mermaid source (040 FR-005)", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await sendMermaidReply(page);
  // The valid block's code element is hidden but still holds the source; the
  // broken block's copy button is the plain-path one to exercise.
  const brokenCopy = reply(page)
    .locator("pre")
    .filter({ has: page.locator("code.language-mermaid", { hasText: "A --> ];" }) })
    .locator(".code-copy-btn");
  await brokenCopy.click();
  await expect(brokenCopy).toHaveText("✓");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("A --> ];");
});
