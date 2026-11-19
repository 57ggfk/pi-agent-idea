import { expect, test } from "@playwright/test";

/**
 * 044 FR-014: a draft referencing a temp paste file that the session-level
 * cleanup already removed must NOT submit silently — the composer blocks the
 * send with an explicit "temp file cleaned up" hint until the reference is
 * edited away.
 */

async function saveAsFileRef(page: import("@playwright/test").Page) {
  const huge = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
  await page.evaluate((payload) => {
    const ta = document.querySelector('[data-testid="composer-input"]')!;
    const dt = new DataTransfer();
    dt.setData("text/plain", payload);
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, huge);
  // A paste beyond the 2000-line threshold auto-saves to a temp file and
  // swaps the folded chip for an `@path` reference (044 FR-011/FR-012) —
  // there is no button to click, the write happens on the paste itself.
  //
  // The old helper waited for a `paste-big-hint` testid (that string is a CSS
  // CLASS, the elements carry `paste-save-failed` / `temp-ref-warning`) and
  // then clicked a `paste-save-file` testid (the real one is
  // `paste-preview-save`, and it only exists inside the hover preview).
  // Both selectors were wrong, so all three cases failed on the first
  // assertion — the feature itself was never exercised.
  await expect(page.getByTestId("ref-token")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("paste-chip")).toHaveCount(0);
}

test("a send with a stale temp reference is blocked with an explicit hint (044 FR-014)", async ({ page }) => {
  await page.goto("/?temprefs=gone");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await saveAsFileRef(page);

  const msgsBefore = await page.evaluate(() => document.querySelectorAll(".markdown").length);
  await page.getByTestId("send-btn").click();

  // Blocked: the explicit "cleaned up" hint shows, nothing is submitted.
  const warning = page.getByTestId("temp-ref-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("pi-paste");
  await expect(page.locator(".markdown")).toHaveCount(msgsBefore);
});

test("dismissing the hint and removing the reference unblocks the send", async ({ page }) => {
  await page.goto("/?temprefs=gone");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await saveAsFileRef(page);
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("temp-ref-warning")).toBeVisible();

  // Remove the stale reference (select the @token and delete it, 018 UX).
  await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
  });
  await page.keyboard.press("Backspace");
  await page.keyboard.type("a plain message without references");

  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("temp-ref-warning")).toHaveCount(0);
  await expect(page.locator(".markdown").last()).toContainText("a plain message without references", { timeout: 30_000 });
});

test("without the knob the send goes through as before (fail-open / existing path)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await saveAsFileRef(page);
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("temp-ref-warning")).toHaveCount(0);
  // The message body carries the reference text; pi reads the file itself.
  await expect(page.locator(".markdown").last()).toContainText(".pi-agent/pi-paste/m0ck-1.txt", { timeout: 30_000 });
});
