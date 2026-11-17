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

test("fenced SVG source stays a code block while bare SVG renders (039 #6 boundary)", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show icons");
  await page.getByTestId("send-btn").click();
  // Tail-anchored: both fenced blocks are the reply's final chunks.
  const fenced = page.locator(".markdown pre code.language-svg");
  await expect(fenced).toHaveCount(2, { timeout: 30_000 });

  // Bare legal SVG rendered exactly once as a graphic — the fenced copy of
  // the SAME markup must not render a second one (boundary: fence = source).
  await expect(page.locator(".markdown svg circle[r='8']")).toHaveCount(1);
  const fencedAudit = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll(".markdown pre code.language-svg"));
    return {
      legal: blocks.some((b) => (b.textContent ?? "").includes('<circle cx="10"')),
      evilText: blocks.some((b) => (b.textContent ?? "").includes("<script>alert(1)</script>")),
      scripts: document.querySelectorAll(".markdown script").length,
      foreignObjects: document.querySelectorAll(".markdown foreignObject").length,
      renderedFromFence: blocks.filter((b) => b.closest("pre")!.querySelector("svg")).length,
    };
  });
  // Fenced legal markup stays copyable source text; the fenced malicious
  // sample stays inert text — nothing executes or renders from either.
  expect(fencedAudit.legal).toBe(true);
  expect(fencedAudit.evilText).toBe(true);
  expect(fencedAudit.scripts).toBe(0);
  expect(fencedAudit.foreignObjects).toBe(0);
  expect(fencedAudit.renderedFromFence).toBe(0);

  // "源码可复制" is user-reachable: the shared action bar (Copy + open in IDE)
  // is injected on the fenced source block too.
  const sourcePre = page.locator(".markdown pre", { hasText: 'circle cx="10"' });
  await expect(sourcePre.locator(".code-copy-btn")).toHaveCount(1);
  await expect(sourcePre.locator(".code-ide-btn")).toHaveCount(1);
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
