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
