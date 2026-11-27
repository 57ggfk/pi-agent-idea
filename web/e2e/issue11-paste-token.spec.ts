import { expect, test, type Page } from "@playwright/test";

/**
 * Issue #11 — the folded-paste placeholder was hardcoded English.
 *
 * The token is the RESTORE KEY: the draft is expanded back to the original
 * content before sending. So the wording is localized, but a token created
 * in one language must stay recognizable in the other — otherwise the user
 * would send the literal "[已粘贴 …]" text to pi.
 */

/** Dispatches a synthetic paste (the same helper the 044 spec uses). */
async function pasteText(page: Page, text: string) {
  await page.evaluate((payload) => {
    const ta = document.querySelector('[data-testid="composer-input"]')!;
    const dt = new DataTransfer();
    dt.setData("text/plain", payload);
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

const BIG_MARKDOWN = Array.from({ length: 10 }, (_, i) => `## section ${i}\n\n- item ${i}`).join("\n");
const BIG_LINES = BIG_MARKDOWN.split("\n").length;

/** The draft's text. */
const draft = (page: Page) =>
  page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);

test("a Chinese UI writes a Chinese placeholder (issue #11)", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await pasteText(page, BIG_MARKDOWN);

  const chip = page.getByTestId("paste-chip");
  await expect(chip).toHaveCount(1);
  const token = `[已粘贴 Markdown #1 +${BIG_LINES} 行]`;
  await expect(chip).toContainText(token);
  // The token in the textarea IS the visible text (the chip paints over it).
  const value = await draft(page);
  expect(value).toContain(token);
  expect(value).not.toContain("Pasted");
});

test("an English token survives a switch to Chinese and still expands (issue #11)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await pasteText(page, BIG_MARKDOWN);
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  const englishToken = `[Pasted Markdown #1 +${BIG_LINES} lines]`;

  // The user switches the UI language while the token sits in the draft.
  await page.getByTestId("options-btn").click();
  await page.getByTestId("opt-language-zh").click();
  await expect(page.getByTestId("tab-chat")).toHaveText("聊天");

  // The token is still recognized: the chip is there and the draft still
  // carries it (the token is NOT rewritten — that would move the caret).
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  expect(await draft(page)).toContain(englishToken);

  // And it still expands back to the original content.
  await page.getByTestId("paste-chip").click();
  await expect(page.getByTestId("paste-collapse")).toBeVisible();
  expect(await draft(page)).toContain("section 0");
});

test("a Chinese token survives a switch to English and still expands (issue #11)", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await pasteText(page, BIG_MARKDOWN);
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  const chineseToken = `[已粘贴 Markdown #1 +${BIG_LINES} 行]`;

  await page.getByTestId("options-btn").click();
  await page.getByTestId("opt-language-en").click();
  await expect(page.getByTestId("tab-chat")).toHaveText("Chat");

  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  expect(await draft(page)).toContain(chineseToken);

  await page.getByTestId("paste-chip").click();
  await expect(page.getByTestId("paste-collapse")).toBeVisible();
  expect(await draft(page)).toContain("section 0");
});

test("the Chinese placeholder reaches pi as the FULL content, not as a token (issue #11)", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await pasteText(page, BIG_MARKDOWN);
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);

  await page.getByTestId("send-btn").click();

  // The transcript carries the original content — the restore key worked
  // across the language boundary.
  await expect(page.locator(".markdown").first()).toContainText("section 0", { timeout: 30_000 });
  const raw = await page.evaluate(() => document.querySelector(".markdown")?.textContent ?? "");
  expect(raw).not.toContain("已粘贴");
});
