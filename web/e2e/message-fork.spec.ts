import { expect, test, type Page } from "@playwright/test";

/**
 * Spec 007 US1 — message-level Fork.
 *
 * fork / clone semantics come from measurements against pi 1.5.0
 * (`specs/007-message-fork/fork-semantics.json`): `fork {entryId}` branches
 * *before* that user entry, so a reply followed by another question branches at
 * the next question, and the last reply is duplicated with `clone`.
 */

async function sendAndWait(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

/** Hovers a message and clicks its Fork button. */
async function forkAt(page: Page, index: number) {
  const reply = page.getByTestId("item-assistant").nth(index);
  await reply.hover();
  await reply.getByTestId("act-fork").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

/** US1 scenario 2 / FR-004 — forking the last reply copies the whole branch. */
test("forking the last reply keeps every message (clone instead of fork)", async ({ page }) => {
  await sendAndWait(page, "the only question");
  await expect(page.getByTestId("item-user")).toHaveCount(1);
  const replyCount = await page.getByTestId("item-assistant").count();

  // The *last* reply, by role (the mock settles a turn with two assistant
  // items, so the first one is not the tail of the conversation).
  await forkAt(page, replyCount - 1);
  // The wording must say the conversation is copied — a plain "fork" here
  // would drop the very answer the user asked to branch from.
  await expect(page.getByTestId("confirm-message")).toContainText(/whole conversation/i);
  await page.getByTestId("confirm-ok").click();

  await expect(page.getByTestId("item-user")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("item-user").first()).toContainText("the only question");
  expect(await page.getByTestId("item-assistant").count()).toBe(replyCount);

  await page.getByTestId("tab-sessions").click();
  await expect(page.locator(".session-name", { hasText: "Cloned session" })).toBeVisible();
});

/** US1 scenario 5 — cancelling changes nothing at all. */
test("cancelling the fork dialog leaves the conversation untouched", async ({ page }) => {
  await sendAndWait(page, "q1");
  await sendAndWait(page, "q2");
  await expect(page.getByTestId("item-user")).toHaveCount(2);

  await forkAt(page, 0);
  await page.getByTestId("confirm-cancel").click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);

  await expect(page.getByTestId("item-user")).toHaveCount(2);
  await expect(page.getByTestId("item-user").nth(1)).toContainText("q2");
  // Still on the same session: the sessions list has no branch row yet.
  await page.getByTestId("tab-sessions").click();
  await expect(page.locator(".session-name", { hasText: "Forked session" })).toHaveCount(0);
});

/** US1 scenario 6 — the session we forked away from is still there, unchanged. */
test("the old session survives the fork and shows the same messages", async ({ page }) => {
  await sendAndWait(page, "q1");
  await sendAndWait(page, "q2");
  await expect(page.getByTestId("item-user")).toHaveCount(2);

  await forkAt(page, 0);
  await page.getByTestId("confirm-ok").click();
  // The branch ends at the first answer: the second question is gone.
  await expect(page.getByTestId("item-user")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("item-user").first()).toContainText("q1");

  await page.getByTestId("tab-sessions").click();
  const previous = page.getByTestId("session-row").filter({ hasText: "Previous session" });
  await expect(previous).toBeVisible();
  await previous.locator(".session-row-main").click();

  // Switching back restores the two-round transcript verbatim.
  await expect(page.getByTestId("item-user")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId("item-user").nth(0)).toContainText("q1");
  await expect(page.getByTestId("item-user").nth(1)).toContainText("q2");
});

/** FR-001 — only pi replies get Fork, never user or system messages. */
test("the Fork button only appears on pi replies", async ({ page }) => {
  await sendAndWait(page, "q1");
  const user = page.getByTestId("item-user").first();
  await user.hover();
  await expect(user.getByTestId("act-copy")).toHaveCount(1);
  await expect(user.getByTestId("act-fork")).toHaveCount(0);

  const reply = page.getByTestId("item-assistant").first();
  await reply.hover();
  await expect(reply.getByTestId("act-fork")).toHaveCount(1);
});

/** FR-002 — no Fork while pi is still answering. */
test("no Fork on a reply while a run is in flight", async ({ page }) => {
  await sendAndWait(page, "q1");
  // Start a second run and look at the *first* (already finished) reply while
  // pi is busy: the toolbar stays, but Fork is gone.
  await page.getByTestId("composer-input").fill("q2");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });

  const reply = page.getByTestId("item-assistant").first();
  await reply.hover();
  await expect(reply.getByTestId("act-copy")).toHaveCount(1);
  await expect(reply.getByTestId("act-fork")).toHaveCount(0);

  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
});

/** US1 scenario 7 / FR-012 — a cancelled branch is visible, the view stays. */
test("a fork cancelled by a pi extension shows an error and stays put", async ({ page }) => {
  await page.goto("/?cancelfork=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await sendAndWait(page, "q1");
  await sendAndWait(page, "q2");

  await forkAt(page, 0);
  await page.getByTestId("confirm-ok").click();

  // The branch was refused: nothing is replayed, and pi's refusal is visible.
  const error = page.getByTestId("system-item").filter({ hasText: /cancelled/i });
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(error).toHaveClass(/item-error/);
  await expect(page.getByTestId("item-user")).toHaveCount(2);
});

// -- 018 US7: the forked session's title carries a localized suffix -----------

test("a fork appends the (fork) suffix to the cloned title, once", async ({ page }) => {
  // The mock normally keeps boot state nameless (the auto-titler owns it);
  // ?sessname gives the session a name so the suffix has something to attach to.
  await page.goto("/?sessname=My%20Session");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await sendAndWait(page, "hello there");

  await forkAt(page, 0);
  await page.getByTestId("confirm-ok").click();

  // The clone inherited the parent title; the plugin appends the suffix once.
  await expect(page.getByTestId("status-session")).toContainText("My Session (fork)", { timeout: 15_000 });

  // Forking again must not stack suffixes.
  await forkAt(page, 0);
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("status-session")).toContainText("My Session (fork)", { timeout: 15_000 });
  const value = await page.getByTestId("status-session").innerText();
  expect(value.split("(fork)").length - 1).toBe(1);
});
