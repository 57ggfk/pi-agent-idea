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
  // The full text never entered the textarea — only the token did.
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value).toBe(token);
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
  expect(value).toBe(BIG_MARKDOWN);

  // While untouched, the affordance folds it back into the same chip.
  await page.getByTestId("paste-collapse").click();
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  await expect(page.getByTestId("paste-collapse")).toHaveCount(0);

  // Editing the expanded content retires the affordance (plain prose again).
  await page.getByTestId("paste-chip").click();
  await page.keyboard.type("edited ");
  await expect(page.getByTestId("paste-collapse")).toHaveCount(0);
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

test("pastes beyond 2000 lines are offered the save-as-file route and get an @ref (044 US7)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  const huge = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
  await pasteText(page, huge);

  await expect(page.getByTestId("paste-big-hint")).toBeVisible();
  await page.getByTestId("paste-save-file").click();

  // The chip is replaced by an @path reference; pi will read the file itself.
  await expect(page.getByTestId("paste-chip")).toHaveCount(0);
  await expect(page.getByTestId("ref-token")).toHaveCount(1);
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value).toContain("@/tmp/mock-home/.pi/pastes/pasted-1.txt");
  expect(value).not.toContain("[Pasted");
});

test("a failed temp write keeps the folded chip and its content (044 FR-013)", async ({ page }) => {
  await page.goto("/?saveTemp=fail");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  const huge = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
  await pasteText(page, huge);
  await expect(page.getByTestId("paste-big-hint")).toBeVisible();

  await page.getByTestId("paste-save-file").click();
  // The write failed: the chip stays, nothing is lost, no empty @ref appears.
  await expect(page.getByTestId("paste-chip")).toHaveCount(1);
  await expect(page.getByTestId("ref-token")).toHaveCount(0);
  const value = await page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);
  expect(value).toContain("[Pasted");
});
