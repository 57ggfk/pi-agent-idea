import { expect, test } from "@playwright/test";

/**
 * "Open in IDE" on fenced code blocks (041): every block gets Copy + an IDE
 * button side by side; the click hands `language` + full `text` to
 * `ide.openSnippet`; failures flash ✗ without breaking anything.
 *
 * The action bar sits ABOVE the block and OUTSIDE it (the code block scrolls
 * horizontally, so the bar cannot be a child of the `pre`), hence the
 * `xpath=..` hop to the block's shell.
 */

async function sendDiffReply(page: import("@playwright/test").Page, extra = "") {
  const query = ["md=diff", ...extra.split(",").filter(Boolean)].join("&");
  await page.goto(`/?${query}`);
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("apply it");
  await page.getByTestId("send-btn").click();
  // The reply carries several pres (tool card, diff block, bash echo) — aim
  // at the diff one directly.
  const code = page.locator(".markdown pre code.language-diff");
  await expect(code).toHaveCount(1, { timeout: 30_000 });
  const pre = page.locator(".markdown pre").filter({ has: page.locator("code.language-diff") });
  // Settled = the reply's trailing footnote section arrived (end of stream).
  await expect(page.locator(".markdown section.footnotes")).toContainText("Follow-up notes.", { timeout: 30_000 });
  return pre;
}

/** The action bar of the block that owns this `pre` (a shell sibling). */
const actionsOf = (pre: import("@playwright/test").Locator) => pre.locator("xpath=..").locator(".block-actions");

test("every code block gets Copy + an IDE button, side by side (041 FR-001)", async ({ page }) => {
  const pre = await sendDiffReply(page);
  const actions = actionsOf(pre);
  await expect(actions.locator(".code-copy-btn")).toHaveCount(1);
  await expect(actions.locator(".code-ide-btn")).toHaveText("Open in IDE");
  // Side by side: the IDE button must not overlap the Copy button.
  const boxes = await page.evaluate(() => {
    const a = document.querySelector(".code-copy-btn")!.getBoundingClientRect();
    const b = document.querySelector(".code-ide-btn")!.getBoundingClientRect();
    return { aRight: a.right, bLeft: b.left, overlap: b.left < a.right - 0.5 };
  });
  expect(boxes.overlap).toBe(false);
});

test("the click sends the block's language and full text (041 FR-002/US1)", async ({ page }) => {
  const pre = await sendDiffReply(page);
  await pre.hover();
  await actionsOf(pre).locator(".code-ide-btn").click();
  const echoed = await page.evaluate(() => globalThis.sessionStorage.getItem("pi-mock-open-snippet"));
  expect(echoed).not.toBeNull();
  const { language, text } = JSON.parse(echoed!);
  expect(language).toBe("diff");
  expect(text).toContain('+console.log("new");');
  expect(text).toContain("context stays");
});

test("a failed bridge call flashes ✗ and recovers (041 FR-007/US2)", async ({ page }) => {
  const pre = await sendDiffReply(page, "openSnippet=fail");
  await pre.hover();
  const btn = actionsOf(pre).locator(".code-ide-btn");
  await btn.click();
  await expect(btn).toHaveText("✗");
  await expect(btn).toHaveText("Open in IDE", { timeout: 3000 });
  // The page is intact: the button is still clickable.
  await expect(btn).toBeEnabled();
});

test("zero regression: copy button still copies (041 FR-006)", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const pre = await sendDiffReply(page);
  await pre.hover();
  await actionsOf(pre).locator(".code-copy-btn").click();
  await expect(actionsOf(pre).locator(".code-copy-btn")).toHaveText("✓");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('+console.log("new");');
});
