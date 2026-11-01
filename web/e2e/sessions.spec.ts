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

  // Delete removes the row (confirm dialog must be accepted).
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("session-delete").first().click();
  await expect(page.getByTestId("session-row")).toHaveCount(before);
});

test("fork branches the conversation into a new session", async ({ page }) => {
  await page.getByTestId("composer-input").fill("hello fork");
  await page.getByTestId("send-btn").click();
  // Wait for the run to settle so the Fork button is enabled again.
  await expect(page.getByTestId("fork-btn")).toBeEnabled({ timeout: 30_000 });

  await page.getByTestId("fork-btn").click();

  // Fork switches to the new session; it shows up in the sessions list.
  await page.getByTestId("tab-sessions").click();
  await expect(page.locator(".session-name", { hasText: "Forked session" })).toBeVisible();
});
