import { expect, test } from "@playwright/test";

/**
 * Paste folding for large text (044): a >3-line / >800-char plain-text paste
 * folds into a chip token; the full content rides in the paste map and is
 * restored at send (FR-007). Chips expand (click) and collapse while
 * untouched, preview on hover, Shift+paste skips folding.
 */

/**
 * Dispatches a synthetic paste (trusted CDP clicks drive the pills).
 * `defaultInsert`: a real (trusted) paste inserts its text natively when the
 * app does not fold; an untrusted synthetic event has no default action, so
 * the tests emulate it with execCommand — the same code path the browser's
 * default insertion runs through.
 */
async function pasteText(page: import("@playwright/test").Page, text: string, defaultInsert = false) {
  await page.evaluate((payload) => {
    const ta = document.querySelector('[data-testid="composer-input"]')!;
    const dt = new DataTransfer();
    dt.setData("text/plain", payload);
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  if (defaultInsert) {
    await page.evaluate((payload) => {
      const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
      ta.focus();
      // The React value setter + input event: what the browser's default
      // insertion feeds onChange (execCommand would inject CRLF on Windows).
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(ta, payload);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }, text);
  }
}

const BIG_MARKDOWN = Array.from({ length: 10 }, (_, i) => `## section ${i}\n\n- item ${i}`).join("\n");
const BIG_LINES = BIG_MARKDOWN.split("\n").length;

test("a large paste folds into a chip and the box stays compact (044 US1)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  const heightBefore = await page.evaluate(() => document.querySelector('[data-testid="composer-input"]')!.clientHeight);
  await pasteText(page, BIG_MARKDOWN);

  const token = `[Pasted Markdown #1 +${BIG_LINES} lines]`;
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  await expect(page.getByTestId("paste-chip")).toContainText(token);
  // The full text never entered the textarea — only the token did, followed
  // by the unified trailing (045: multi-line paste → newline).
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value).toBe(token + "\n");
  const heightAfter = await page.evaluate(() => document.querySelector('[data-testid="composer-input"]')!.clientHeight);
  expect(heightAfter).toBeLessThan(120);
  expect(heightBefore).toBeGreaterThan(0);
});

test("clicking the chip expands the full content; collapse folds it back (044 US2)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await pasteText(page, BIG_MARKDOWN);
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);

  await page.getByTestId("paste-chip").click();
  await expect(page.getByTestId("paste-collapse")).toBeVisible();
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  // The fold's trailing newline stays in the draft after the expansion.
  expect(value).toBe(BIG_MARKDOWN + "\n");

  // While untouched, the affordance folds it back into the same chip.
  await page.getByTestId("paste-collapse").click();
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  await expect(page.getByTestId("paste-collapse")).toHaveCount(0);
});

test("expanded content stays foldable after edits; the fold captures the edited text (044 #2b)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await pasteText(page, BIG_MARKDOWN);
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);

  // Expand, then edit inside the content — the affordance STAYS now.
  await page.getByTestId("paste-chip").click();
  await expect(page.getByTestId("paste-collapse")).toBeVisible();
  await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(0, 0);
  });
  // Shift+Enter inserts the newline WITHOUT sending (plain Enter sends).
  await page.keyboard.type("edited");
  await page.keyboard.press("Shift+Enter");
  await expect(page.getByTestId("paste-collapse")).toBeVisible();

  // Fold: the chip token carries the EDITED line count (+11 lines).
  await page.getByTestId("paste-collapse").click();
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  await expect(page.getByTestId("paste-collapse")).toHaveCount(0);
  await expect(page.getByTestId("paste-chip")).toContainText(`[Pasted Markdown #1 +${BIG_LINES + 1} lines]`);

  // Re-expand: the edited text comes back, exactly as typed (plus the fold's
  // trailing newline, which stays in the draft).
  await page.getByTestId("paste-chip").click();
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value).toBe(`edited\n${BIG_MARKDOWN}\n`);

  // Several round trips stay stable.
  await page.getByTestId("paste-collapse").click();
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  await page.getByTestId("paste-chip").click();
  const value2 = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value2).toBe(`edited\n${BIG_MARKDOWN}\n`);
});

test("a fold of sub-threshold content degenerates to plain text (044 #2b)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await pasteText(page, BIG_MARKDOWN);
  await page.getByTestId("paste-chip").click();
  await expect(page.getByTestId("paste-collapse")).toBeVisible();
  // Select the whole expanded content and overwrite it with a short line.
  await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
  });
  await page.keyboard.type("just a short line");
  // Folding short prose retires the affordance and keeps it as plain text.
  await page.getByTestId("paste-collapse").click();
  await expect(page.getByTestId("paste-chip")).toHaveCount(0);
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value).toBe("just a short line");
});

test("hovering a chip shows a read-only preview (044 US3)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await pasteText(page, BIG_MARKDOWN);
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);

  await page.getByTestId("paste-chip").hover();
  await expect(page.getByTestId("paste-preview")).toBeVisible();
  await expect(page.getByTestId("paste-preview")).toContainText(`Pasted Markdown (${BIG_LINES} lines)`);
  await expect(page.getByTestId("paste-preview")).toContainText("section 0");
  // Preview leaves without changing the box.
  await page.getByTestId("composer-input").click();
  await expect(page.getByTestId("paste-preview")).toHaveCount(0);
});

test("Shift+paste skips folding and inserts the full text (044 US4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await page.keyboard.down("Shift");
  await pasteText(page, BIG_MARKDOWN, true);
  await page.keyboard.up("Shift");

  await expect(page.getByTestId("paste-chip")).toHaveCount(0);
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value).toBe(BIG_MARKDOWN);
});

test("short pastes insert directly — no chip (044 US6)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await pasteText(page, "two short\nlines only", true);
  await expect(page.getByTestId("paste-chip")).toHaveCount(0);
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value).toBe("two short\nlines only");
});

test("sending a folded paste delivers the full original to the transcript (044 US5)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  const content = BIG_MARKDOWN + "\n\nmarker-final-line";
  await pasteText(page, content);
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);

  // Type a prefix before the token, then send.
  await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(0, 0);
  });
  await page.keyboard.type("look at this: ");

  await page.getByTestId("send-btn").click();
  // The user message in the transcript carries the full content, not the token.
  await expect(page.locator(".markdown").first()).toContainText("marker-final-line", { timeout: 30_000 });
  const raw = await page.evaluate(() => (document.querySelector(".markdown")?.textContent ?? ""));
  expect(raw).not.toContain("[Pasted Markdown #1");
});

test("pastes beyond 2000 lines auto-save to a temp file reference (044 #4)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  const huge = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
  await pasteText(page, huge);

  // No suggestion bar any more — the save happens on its own and swaps the
  // chip for the @path reference (mock resolves immediately, so the chip may
  // already be gone by the first poll).
  await expect(page.getByTestId("paste-big-hint")).toHaveCount(0);
  await expect(page.getByTestId("paste-save-failed")).toHaveCount(0);
  await expect(page.getByTestId("ref-token")).toHaveCount(1, { timeout: 10_000 });
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value).toContain("@/tmp/mock-home/pi-paste-1-x/pasted-1.txt");
  expect(value).not.toContain("[Pasted");
});

test("a failed auto temp write keeps the folded chip, shows a dismissible notice (044 #4/FR-013)", async ({ page }) => {
  await page.goto("/?saveTemp=fail");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  const huge = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
  await pasteText(page, huge);
  // The write failed: the chip stays, nothing is lost, no empty @ref, and a
  // perceivable (dismissible) failure notice appears.
  await expect(page.getByTestId("paste-save-failed")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  await expect(page.getByTestId("ref-token")).toHaveCount(0);
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value).toContain("[Pasted");
  await page.getByTestId("paste-save-failed-dismiss").click();
  await expect(page.getByTestId("paste-save-failed")).toHaveCount(0);
});

test("hover preview survives the chip→overlay trip and the save button works (044 #1/#3)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await pasteText(page, BIG_MARKDOWN);
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);

  await page.getByTestId("paste-chip").hover();
  await expect(page.getByTestId("paste-preview")).toBeVisible();
  // Real mouse path across the (former) gap into the overlay's save button —
  // a synthetic click cannot prove the hover keeps the overlay alive.
  const btn = page.getByTestId("paste-preview-save");
  const box = await btn.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y - 8); // just above the button, inside the overlay
  await expect(page.getByTestId("paste-preview")).toBeVisible();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await btn.click();
  // The save went through: the chip is replaced by the @path reference.
  await expect(page.getByTestId("ref-token")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("paste-preview")).toHaveCount(0);
});

test("Esc closes the hover preview without touching the draft (044 #3)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await pasteText(page, BIG_MARKDOWN);
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  await page.getByTestId("paste-chip").hover();
  await expect(page.getByTestId("paste-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("paste-preview")).toHaveCount(0);
  // The draft is untouched (including the fold's trailing newline).
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value).toBe(`[Pasted Markdown #1 +${BIG_LINES} lines]\n`);
});
