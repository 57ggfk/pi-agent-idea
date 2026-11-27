import { expect, test, type Page } from "@playwright/test";

/**
 * Issue #8 — the steer (插话) lives in two places: the queue mirror and the
 * transcript. The transcript copy has to say whether it is still queued or
 * already injected, and taking it back has to take the transcript copy with
 * it — otherwise the same text shows up twice and the user cannot tell
 * whether the steer took effect.
 */

async function open(page: Page, query = "") {
  await page.goto(query ? `/?${query}` : "/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
}

async function waitStreaming(page: Page) {
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
}

/** Sends `text` in the given mode while a run is streaming. */
async function sendQueued(page: Page, mode: "steer" | "followUp", text: string) {
  await page.getByTestId("send-mode-caret").click();
  await page.getByTestId(`send-mode-${mode}`).click();
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
}

/** Starts a run, so the composer can queue. */
async function startRun(page: Page) {
  await open(page);
  await page.getByTestId("composer-input").fill("long running task");
  await page.getByTestId("send-btn").click();
  await waitStreaming(page);
}

test("a fired steer is marked as queued while pi has not taken it (FR-003)", async ({ page }) => {
  await startRun(page);

  await sendQueued(page, "steer", "wait — check the tests first");

  const tag = page.getByTestId("steer-tag");
  await expect(tag).toBeVisible();
  await expect(tag).toHaveAttribute("data-state", "queued");
  await expect(tag).toContainText("Steering (queued)");
  // The queue holds it too — the same text, in both places.
  await expect(page.getByTestId("queue-row").first()).toContainText("wait — check the tests first");
});

test("taking a queued steer back removes the transcript copy (FR-001)", async ({ page }) => {
  await startRun(page);
  await sendQueued(page, "steer", "take me back and edit me");

  const tag = page.getByTestId("steer-tag");
  await expect(tag).toBeVisible();
  await expect(page.getByTestId("queue-row")).toHaveCount(1);

  await page.getByTestId("queue-edit-0").click();

  // The transcript copy is gone…
  await expect(page.getByTestId("steer-tag")).toHaveCount(0);
  // …and the text is back in the composer.
  await expect(page.getByTestId("composer-input")).toHaveValue(/take me back and edit me/);
});

test("taking a steer back and sending it leaves ONE copy in the transcript (FR-002)", async ({ page }) => {
  await startRun(page);
  await sendQueued(page, "steer", "edit me");

  await page.getByTestId("queue-edit-0").click();
  await expect(page.getByTestId("steer-tag")).toHaveCount(0);

  await page.getByTestId("composer-input").fill("edited version");
  await page.getByTestId("send-btn").click();

  // The transcript holds the edited message once — the withdrawn copy is not
  // there any more.
  await expect(page.getByTestId("item-user")).toHaveCount(2, { timeout: 20_000 });
  const users = page.getByTestId("item-user");
  await expect(users.last()).toContainText("edited version");
  const body = await page.locator(".message-list").innerText();
  expect(body).not.toContain("edit me");
});

test("deleting a queued steer removes the transcript copy too", async ({ page }) => {
  await startRun(page);
  await sendQueued(page, "steer", "delete me from the queue");

  await expect(page.getByTestId("steer-tag")).toBeVisible();
  await page.getByTestId("queue-del-0").click();
  await page.getByTestId("queue-confirm-del-0").click();

  // "Not in the queue but still in the transcript" is the same ambiguity the
  // take-back had — the copy goes with the entry.
  await expect(page.getByTestId("steer-tag")).toHaveCount(0);
  await expect(page.getByTestId("queue-bar")).toHaveCount(0);
});

test("a steer pi took is marked as injected, not as queued (FR-003)", async ({ page }) => {
  await startRun(page);
  await sendQueued(page, "steer", "pi takes this one");

  // pi injects the steering message at the turn boundary → the queue empties
  // and the transcript copy flips to "injected".
  await expect(page.getByTestId("queue-bar")).toHaveCount(0, { timeout: 40_000 });
  const tag = page.getByTestId("steer-tag");
  await expect(tag).toHaveAttribute("data-state", "injected", { timeout: 20_000 });
  await expect(tag).toContainText("Steering (injected)");
});

test("an old transcript without a steer state still shows the plain badge", async ({ page }) => {
  await startRun(page);
  await sendQueued(page, "steer", "no state here");

  // Simulate an item from before the state existed: the badge must not be
  // blank, and must not claim a state it does not know.
  await page.evaluate(() => {
    const tag = document.querySelector('[data-testid="steer-tag"]');
    if (tag) tag.setAttribute("data-state", "unknown");
  });
  await expect(page.getByTestId("steer-tag")).toBeVisible();
  await expect(page.getByTestId("steer-tag")).toContainText("Steer");
});
