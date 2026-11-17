import { expect, test, type Page } from "@playwright/test";

/**
 * 045: every injection path ends with the unified trailing — multi-line
 * content → one newline, single-line → two spaces (Markdown hard break) —
 * applied once at the composer's collection points, never stacked, and the
 * caret lands after it (044 #2a's "no visible cursor after folding").
 */

declare global {
  interface Window {
    __piMockIde?: (data: unknown) => void;
  }
}

async function pushIde(page: Page, data: Record<string, unknown>) {
  await page.evaluate((d) => window.__piMockIde?.(d), data);
}

const value = (page: Page) =>
  page.evaluate(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).value);

const caret = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    return { start: el.selectionStart, end: el.selectionEnd, len: el.value.length };
  });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
});

test("an ide push ends with the unified trailing — single-line two spaces, multi-line newline (045 Q2)", async ({ page }) => {
  // The ide event pushes run in replace mode (the store hardcodes it).
  await pushIde(page, { kind: "prompt", text: "one line of prose" });
  await expect(value(page)).resolves.toBe("one line of prose  ");

  await pushIde(page, { kind: "prompt", text: "line one\nline two" });
  await expect(value(page)).resolves.toBe("line one\nline two\n");
});

test("a message quote ends with the unified trailing (045 Q2)", async ({ page }) => {
  await page.getByTestId("composer-input").fill("hello");
  await page.getByTestId("send-btn").click();
  // Settle BEFORE hovering (repo pattern: busy → not busy): streaming
  // re-renders keep flickering the hover action bars, which makes the quote
  // click unreliably land.
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });

  const user = page.getByTestId("item-user").first();
  // The action bar shows on item hover.
  await user.hover();
  await expect(user.getByTestId("act-quote")).toBeVisible({ timeout: 30_000 });
  await user.getByTestId("act-quote").click();
  // Single-line quoted content → two spaces (Markdown hard break). The
  // composer text commits asynchronously — poll.
  await expect.poll(() => value(page)).toBe("> hello  ");

  // The assistant reply is multi-line markdown → one newline.
  const assistant = page.getByTestId("item-assistant").last();
  await assistant.hover();
  await assistant.getByTestId("act-quote").click();
  await expect.poll(() => value(page)).toMatch(/^> /);
  await expect.poll(() => value(page)).toMatch(/\n$/);
  const v = await value(page);
  expect(v.endsWith("  \n")).toBe(false);
});

test("quote content already ending in a newline is not stacked (045 FR-003)", async ({ page }) => {
  await pushIde(page, { kind: "prompt", mode: "quote", text: "already ends\nwith newline\n" });
  await expect(value(page)).resolves.toBe("already ends\nwith newline\n");
});

test("a folded paste puts the caret after the trailing — on a fresh line for multi-line (045/044 #2a)", async ({ page }) => {
  const multi = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  await page.evaluate((t) => {
    const ta = document.querySelector('[data-testid="composer-input"]')!;
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, multi);
  const token = "[Pasted text #1 +10 lines]";
  await expect(value(page)).resolves.toBe(`${token}\n`);
  // The caret sits past the trailing — visibly on its own line, ready to type.
  await expect(caret(page)).resolves.toEqual({ start: token.length + 1, end: token.length + 1, len: token.length + 1 });
});

test("a single-line long paste folds with the two-space trailing (045 Q2)", async ({ page }) => {
  const long = "x".repeat(900);
  await page.evaluate((t) => {
    const ta = document.querySelector('[data-testid="composer-input"]')!;
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, long);
  const token = "[Pasted text #1 +1 lines]";
  await expect(value(page)).resolves.toBe(`${token}  `);
  await expect(caret(page)).resolves.toEqual({ start: token.length + 2, end: token.length + 2, len: token.length + 2 });
});

test("dragged text gets the unified trailing (045 FR-001)", async ({ page }) => {
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.setData("text/plain", "const answer = 42;");
    return d;
  });
  await page.getByTestId("composer").dispatchEvent("drop", { dataTransfer: dt });
  await expect(value(page)).resolves.toBe("const answer = 42;  ");

  const dt2 = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.setData("text/plain", "first\nsecond");
    return d;
  });
  await page.getByTestId("composer").dispatchEvent("drop", { dataTransfer: dt2 });
  await expect(value(page)).resolves.toBe("const answer = 42;  first\nsecond\n");
});
