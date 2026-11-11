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

/**
 * 023: Fork lives on the *last* reply of a round. The mock settles one
 * question with two pi replies (a tool-call message and the summary), so the
 * round end is always the second one.
 */
const REPLIES_PER_ROUND = 2;

function roundEndReply(page: Page, round = 0) {
  return page.getByTestId("item-assistant").nth(round * REPLIES_PER_ROUND + 1);
}

/** Hovers the last reply of `round` and clicks its Fork. */
async function forkAt(page: Page, round = 0) {
  const reply = roundEndReply(page, round);
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

  // The *last* reply of the only round — a mid-round reply has no Fork (023).
  await forkAt(page, 0);
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

  const reply = roundEndReply(page);
  await reply.hover();
  await expect(reply.getByTestId("act-fork")).toHaveCount(1);
});

/** 023 US1 scenario A — one round, one entry point, on the last reply only. */
test("only the round's last reply offers Fork (023 scenario A)", async ({ page }) => {
  await sendAndWait(page, "q1");
  const replies = page.getByTestId("item-assistant");
  await expect(replies).toHaveCount(REPLIES_PER_ROUND);

  // The tool-call reply is mid-round: toolbar yes, Fork no (023 US3 — copy and
  // quote must not disappear along with Fork).
  const mid = replies.nth(0);
  await mid.hover();
  await expect(mid.getByTestId("msg-actions")).toBeVisible();
  await expect(mid.getByTestId("act-copy")).toHaveCount(1);
  await expect(mid.getByTestId("act-fork")).toHaveCount(0);

  const end = replies.nth(REPLIES_PER_ROUND - 1);
  await end.hover();
  await expect(end.getByTestId("act-fork")).toHaveCount(1);

  // Exactly one entry point in the whole transcript.
  await expect(page.getByTestId("act-fork")).toHaveCount(1);
});

/** 023 US1 scenario B — one entry point per round, so two rounds give two. */
test("a two-round conversation has exactly one Fork per round (023 scenario B)", async ({ page }) => {
  await sendAndWait(page, "q1");
  await sendAndWait(page, "q2");
  const replies = page.getByTestId("item-assistant");
  await expect(replies).toHaveCount(REPLIES_PER_ROUND * 2);

  await expect(page.getByTestId("act-fork")).toHaveCount(2);
  // The round ends are the only ones that carry it.
  await expect(replies.nth(0).getByTestId("act-fork")).toHaveCount(0);
  await expect(replies.nth(1).getByTestId("act-fork")).toHaveCount(1);
  await expect(replies.nth(2).getByTestId("act-fork")).toHaveCount(0);
  await expect(replies.nth(3).getByTestId("act-fork")).toHaveCount(1);
});

/** FR-002 — no Fork while pi is still answering. */
test("no Fork on a reply while a run is in flight", async ({ page }) => {
  await sendAndWait(page, "q1");
  // Start a second run and look at the round end of the finished round while
  // pi is busy: the toolbar stays, but Fork is gone.
  await page.getByTestId("composer-input").fill("q2");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });

  const reply = roundEndReply(page, 0);
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

/**
 * 023 US1 scenario G — a system notice does not close a round, so an error
 * appended after the answer must not cost the round its Fork.
 */
test("a trailing error notice keeps Fork on the round it follows (023 scenario G)", async ({ page }) => {
  await page.goto("/?cancelfork=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await sendAndWait(page, "q1");

  const end = roundEndReply(page);
  await expect(end.getByTestId("act-fork")).toHaveCount(1);

  // A cancelled fork appends an error item at the very end of the transcript.
  await forkAt(page, 0);
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("system-item").filter({ hasText: /cancelled/i })).toBeVisible({
    timeout: 15_000,
  });

  // Were system items round-closing, this reply would now be mid-round.
  await expect(end.getByTestId("act-fork")).toHaveCount(1);
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
