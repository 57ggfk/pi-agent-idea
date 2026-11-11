import { expect, test } from "@playwright/test";

/**
 * 026 — switch stuck: deadlines, convergence, retry (US1–US4).
 *
 * Injection knobs (mock bridge):
 *  - `?hang=switch_session`  the response is swallowed forever (US1)
 *  - `?failcmd=switch_session` the first call refuses (US4 retry)
 *  - `?slow=switch_session:5000` the first call lands 5s late (US3 takeover)
 * * - `?slowN=get_messages:2:1000` the switch's content read (call #2, boot replay is #1) lands 1s late (US2)
 *
 * The store's deadlines (5s switch / 3s abort) are real here — E1 genuinely
 * waits one deadline, which is the point: a page in the mocked state must
 * converge without any outside help.
 */

test("US1: a swallowed switch_session converges into the retry bar within the deadline", async ({ page }) => {
  await page.goto("/?hang=switch_session");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row").first()).toBeVisible();

  await page.getByTestId("session-row").first().click();
  await expect(page.getByTestId("session-switching")).toBeVisible({ timeout: 300 });

  // The 5s local deadline fires; the failure path lands back on the list and
  // raises the retry bar (asserted across the whole 8s budget, not just 5s —
  // the deadline plus UI work must stay inside US1's bound).
  await expect(page.getByTestId("switch-retry-bar")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByTestId("tab-sessions")).toHaveClass(/tab-active/);
  await expect(page.getByTestId("session-switching")).toHaveCount(0);
  // The bar names the target it kept (FR-005).
  await expect(page.getByTestId("switch-retry-bar")).toContainText("/tmp/mock-sessions/2026-10-27");

  // Dismiss forgets the target.
  await page.getByTestId("switch-retry-dismiss").click();
  await expect(page.getByTestId("switch-retry-bar")).toHaveCount(0);
});

test("US4: retry re-fires the failed target and lands in the session", async ({ page }) => {
  await page.goto("/?failcmd=switch_session");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row").first()).toBeVisible();

  await page.getByTestId("session-row").first().click();
  await expect(page.getByTestId("switch-retry-bar")).toBeVisible({ timeout: 5_000 });

  await page.getByTestId("switch-retry-btn").click();
  // The second attempt answers: chat view, no bar, sending unblocked (the
  // composer starts empty, so enablement is asserted after typing, like 021).
  await expect(page.getByTestId("tab-chat")).toHaveClass(/tab-active/, { timeout: 5_000 });
  await expect(page.getByTestId("switch-retry-bar")).toHaveCount(0);
  await page.getByTestId("composer-input").fill("after the retry");
  await expect(page.getByTestId("send-btn")).toBeEnabled();
});

test("US3: clicking new-session during a stuck history switch takes over at once", async ({ page }) => {
  await page.goto("/?slow=switch_session:5000");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row").first()).toBeVisible();

  await page.getByTestId("session-row").first().click();
  await expect(page.getByTestId("session-switching")).toBeVisible({ timeout: 300 });

  // Takeover (FR-004): the new session wins within ~2s — not after the 5s
  // switch finally lands. A short timeout is what separates takeover from
  // the old silent dead button.
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("empty-state")).toBeVisible({ timeout: 2_000 });
  await expect(page.getByTestId("session-switching")).toHaveCount(0);

  // The stale switch's answer (5s) must not drag the old transcript back in.
  await expect(page.getByTestId("empty-state")).toBeVisible({ timeout: 4_000 });
  await expect(page.getByTestId("item-user")).toHaveCount(0);
  await expect(page.getByTestId("session-switching")).toHaveCount(0);
});

test("US2: a late content read never drags the screen back to the older session", async ({ page }) => {
  // `2`: the boot transcript replay already spends get_messages call #1, so
  // the switch's own read (call #2) is the one that lands 1s late.
  await page.goto("/?slowN=get_messages:2:1000");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row")).toHaveCount(2);

  // Two clicks in quick succession — the same race the real machine hit: the
  // second click lands before the re-render swaps the view, so both row
  // buttons are clicked in one synchronous batch (after the first dispatch the
  // tab already moved to chat and the list unmounted).
  await page.evaluate(() => {
    const buttons = document.querySelectorAll<HTMLElement>(
      '[data-testid="session-row"] button.session-row-main',
    );
    for (const b of buttons) {
      b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });

  // The second target completes immediately; the first one's content read
  // arrives a second late and must be dropped (D8 + FR-003 cleanup).
  await expect(page.getByTestId("session-switching")).toHaveCount(0, { timeout: 3_000 });
  await expect(page.getByTestId("empty-state")).toBeVisible({ timeout: 3_000 });

  // Past the 1s late read: still the second (empty) session — no back-fill
  // of "Please refactor the auth module", no placeholder resurrection.
  await expect(page.getByTestId("empty-state")).toBeVisible({ timeout: 2_000 });
  await expect(page.getByTestId("item-user")).toHaveCount(0);
  await expect(page.getByTestId("session-switching")).toHaveCount(0);
});
