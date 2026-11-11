import { expect, test } from "@playwright/test";

/**
 * 024 — session list row actions: copy title+ID (US1), list-level fork
 * (US2), visible failure & single-flight (US3).
 *
 * The old "clone" button was the bug itself: pi's `clone` RPC ignores
 * sessionPath, so every row cloned the live session. These specs pin the new
 * pair (session-copy / session-fork) with numeric/visibility assertions, not
 * existence checks.
 */

/** Records clipboard writes before the app runs (JCEF has no async API). */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (text: string) => {
          (window as unknown as { __copied: string[] }).__copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });
});

test("US1: each row's copy button puts that row's title and ID on the clipboard", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row")).toHaveCount(2);

  const readCopied = () => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

  await page.getByTestId("session-row").nth(0).getByTestId("session-copy").click();
  await page.getByTestId("session-row").nth(1).getByTestId("session-copy").click();
  await page.getByTestId("session-row").nth(0).getByTestId("session-copy").click();

  const copied = await readCopied();
  // Row titles come from the same fields the row renders (name → preview →
  // id); three presses, three payloads, the middle one is the SECOND row.
  expect(copied).toEqual([
    "Refactor auth module\nsession-aaa",
    "Fix the failing tests in CI\nsession-bbb",
    "Refactor auth module\nsession-aaa",
  ]);

  // The outcome is visible on the list itself (not a silent transcript item).
  await expect(page.getByTestId("sessions-notice")).toContainText("Copied");
});

test("US2: forking a non-live row adds a forked row without switching away", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row")).toHaveCount(2);
  // The live session is row 0 (session-aaa): fork row 1, a DIFFERENT session.
  await page.getByTestId("session-row").nth(1).getByTestId("session-fork").click();

  // No view swap — the old bug switched the transcript to the clone.
  await expect(page.getByTestId("tab-sessions")).toHaveClass(/tab-active/, { timeout: 5_000 });
  await expect(page.getByTestId("session-row")).toHaveCount(3, { timeout: 5_000 });
  // The new row carries the (fork) suffix on the inherited name — bbb is
  // unnamed, so the title is the inherited preview; the suffix only applies
  // to named parents (018 rule).
  const forkRowText = await page
    .getByTestId("session-row")
    .nth(0)
    .locator(".session-name")
    .first()
    .textContent();
  expect(forkRowText).toContain("Fix the failing tests in CI");

  // Still nothing playing in chat: the live transcript is untouched.
  await page.getByTestId("tab-chat").click();
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("item-user")).toHaveCount(0);
});

test("US2: forking a named non-live row appends the (fork) suffix", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row")).toHaveCount(2);

  // Name the second row first (012 inline editor, Enter commits).
  await page.getByTestId("session-row").nth(1).getByTestId("session-rename").click();
  const input = page.getByTestId("session-rename-input");
  await expect(input).toBeVisible();
  await input.fill("Beta Named");
  await input.press("Enter");
  await expect(page.getByTestId("session-row").nth(1)).toContainText("Beta Named", { timeout: 5_000 });

  await page.getByTestId("session-row").nth(1).getByTestId("session-fork").click();
  await expect(page.getByTestId("session-row")).toHaveCount(3, { timeout: 5_000 });

  // The forked row's name = source name + the localized suffix.
  const names = await page.locator(".session-name").allTextContents();
  expect(names.filter((n) => n === "Beta Named (fork)")).toHaveLength(1);
});

test("US3: a failed fork shows a visible error and keeps the list unchanged", async ({ page }) => {
  await page.goto("/?forkfail=1");
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row")).toHaveCount(2);

  await page.getByTestId("session-row").nth(1).getByTestId("session-fork").click();

  await expect(page.getByTestId("sessions-notice")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("sessions-notice")).toContainText(/Fork failed/);
  // No ghost row, busy state released (the attribute disappears entirely).
  await expect(page.getByTestId("session-row")).toHaveCount(2);
  await expect(page.getByTestId("session-row").nth(1).getByTestId("session-fork")).not.toHaveAttribute(
    "aria-busy",
    "true",
    { timeout: 5_000 },
  );
  // A second attempt is possible (retry by clicking again) — the mock still
  // fails, and the notice stays honest.
  await page.getByTestId("session-row").nth(1).getByTestId("session-fork").click();
  await expect(page.getByTestId("sessions-notice")).toContainText(/Fork failed/);
});

test("US3: one fork at a time — the busy row pulses, other rows are refused with a notice", async ({ page }) => {
  await page.goto("/?slow=sessionsFork:4000");
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row")).toHaveCount(2);

  await page.getByTestId("session-row").nth(1).getByTestId("session-fork").click();
  await expect(page.getByTestId("session-row").nth(1).getByTestId("session-fork")).toHaveAttribute(
    "aria-busy",
    "true",
    { timeout: 2_000 },
  );

  // Another row during the run: not disabled, but the click is refused with
  // a visible notice instead of queueing a second process.
  await page.getByTestId("session-row").nth(0).getByTestId("session-fork").click();
  await expect(page.getByTestId("sessions-notice")).toContainText(/already running|另一个 Fork/);

  // The running fork still completes exactly once.
  await expect(page.getByTestId("session-row")).toHaveCount(3, { timeout: 8_000 });
  await expect(page.getByTestId("session-row").nth(1).getByTestId("session-fork")).not.toHaveAttribute(
    "aria-busy",
    "true",
    { timeout: 2_000 },
  );
});
