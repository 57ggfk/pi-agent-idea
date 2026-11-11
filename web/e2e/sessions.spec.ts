import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("sessions list shows message counts and supports clone/delete/export", async ({ page }) => {
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("sessions-view")).toBeVisible();

  // Seeded mock sessions carry message counts.
  const rows = page.getByTestId("session-row");
  await expect(rows.first()).toBeVisible();
  await expect(page.locator(".session-preview", { hasText: "12 msgs" }).first()).toBeVisible();

  // Clone: a new session appears and the UI switches to it (chat tab).
  const before = await rows.count();
  await page.getByTestId("session-clone").first().click();
  await expect(page.getByTestId("tab-chat")).toHaveClass(/tab-active/);

  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row")).toHaveCount(before + 1);

  // Export resolves silently (the IDE side would open a save dialog and
  // notify; the mock just returns a path).
  await page.getByTestId("session-export").first().click();

  // Delete removes the row — through the in-app dialog (007 US3-7), never a
  // native one.
  await page.getByTestId("session-delete").first().click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(page.getByTestId("confirm-ok")).toHaveText("Delete");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("session-row")).toHaveCount(before);
});

test("forking a middle reply branches the conversation into a new session", async ({ page }) => {
  // Two rounds, so the first answer is *not* the last one — that is the case
  // that has to branch at the next question rather than clone (007 US1-1).
  for (const text of ["first question", "second question"]) {
    await page.getByTestId("composer-input").fill(text);
    await page.getByTestId("send-btn").click();
    await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
    await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  }
  await expect(page.getByTestId("item-user")).toHaveCount(2);

  // Hovering the *first* pi reply exposes Fork on the message toolbar.
  const firstReply = page.getByTestId("item-assistant").first();
  await firstReply.hover();
  await firstReply.getByTestId("act-fork").click();

  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(page.getByTestId("confirm-message")).toContainText(/current session stays/i);
  await page.getByTestId("confirm-ok").click();

  // The branch keeps the first round and drops the second: pi forks *before*
  // the entry it is given, so this is U1/A1 only.
  await expect(page.getByTestId("item-user")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("item-user").first()).toContainText("first question");
  await expect(page.getByTestId("item-user").filter({ hasText: "second question" })).toHaveCount(0);

  // The new session is listed, and the old one is still there to switch back to.
  await page.getByTestId("tab-sessions").click();
  await expect(page.locator(".session-name", { hasText: "Forked session" })).toBeVisible();
});

// -- 021: session switch / new session responsiveness -------------------------
// Thresholds come from specs/021-session-switch-latency (T1 ≤150ms view,
// T2 ≤300ms placeholder). The RPC delay is injected, so these numbers do not
// depend on how fast the machine is.

test("new session clears the transcript within 150ms, then re-enables sending", async ({ page }) => {
  await page.goto("/?slow=new_session:1200");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  // Content is required, or the store answers without asking pi at all.
  await page.getByTestId("composer-input").fill("hello there");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("item-assistant").first()).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("new-session").click();
  // With content the store asks first (007 US3).
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  const tapped = Date.now();
  await page.getByTestId("confirm-ok").click();

  // T2: the empty conversation is on screen long before pi answers.
  await expect(page.getByTestId("empty-state")).toBeVisible({ timeout: 300 });
  expect(Date.now() - tapped).toBeLessThan(1500);
  // Sending is gated while the switch is in flight (empty composer would be
  // disabled anyway, so the gate is read off the tooltip), and lifts after.
  await expect(page.getByTestId("send-btn")).toHaveAttribute("title", /Switching session/);
  await expect(page.getByTestId("send-btn")).not.toHaveAttribute("title", /Switching session/, { timeout: 5_000 });
  await page.getByTestId("composer-input").fill("after the switch");
  await expect(page.getByTestId("send-btn")).toBeEnabled();
});

test("clicking a history row switches the view at once and shows a placeholder, not the empty state", async ({ page }) => {
  await page.goto("/?slow=switch_session:1200");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row").first()).toBeVisible();

  await page.getByTestId("session-row").first().click();

  // T1: the chat view is active immediately (previously it waited for the RPC).
  await expect(page.getByTestId("tab-chat")).toHaveClass(/tab-active/, { timeout: 150 });
  // T2: a switching placeholder, never the "this session is blank" state.
  await expect(page.getByTestId("session-switching")).toBeVisible({ timeout: 300 });
  await expect(page.getByTestId("empty-state")).toHaveCount(0);
  await expect(page.getByTestId("send-btn")).toBeDisabled();

  // It resolves: the placeholder goes away and sending is unblocked.
  await expect(page.getByTestId("session-switching")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("send-btn")).not.toHaveAttribute("title", /Switching session/);
});

test("a refused switch lands back on the session list with the error visible", async ({ page }) => {
  await page.goto("/?failcmd=switch_session");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row").first()).toBeVisible();

  await page.getByTestId("session-row").first().click();

  await expect(page.getByTestId("tab-sessions")).toHaveClass(/tab-active/, { timeout: 5_000 });
  await expect(page.getByTestId("session-row").first()).toBeVisible();
  // The failure is not silent: the chat tab carries an error item.
  await page.getByTestId("tab-chat").click();
  await expect(page.getByTestId("system-item").filter({ hasText: /switch_session failed|failed/i }).first()).toBeVisible();
});
