import { test, expect } from "@playwright/test";

/**
 * Spec 005 — the plugin-mirrored message queue. All scenarios run against the
 * MockBridge, which reproduces the production contract: pi's text arrays are
 * the truth, the service keeps an id/image mirror, and every local operation
 * is clear → rebuild → re-enqueue.
 */

async function open(page: import("@playwright/test").Page, query = "") {
  await page.goto(query ? `/?${query}` : "/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
}

async function waitStreaming(page: import("@playwright/test").Page) {
  // Sending while idle starts a run; the queue scenarios all begin here.
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
}

async function waitSettled(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 40_000 });
}

/** Sends `text` in the given mode while a run is streaming. */
async function sendQueued(
  page: import("@playwright/test").Page,
  mode: "steer" | "followUp",
  text: string,
) {
  await page.getByTestId("send-mode-caret").click();
  await page.getByTestId(`send-mode-${mode}`).click();
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
}

test.describe("message queue (MockBridge)", () => {
  // -- US1: what is queued is visible ----------------------------------------

  test("follow-ups queue with index, mode tag and preview; the input clears", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("first question");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await sendQueued(page, "followUp", "second question, queued while pi works");
    await expect(page.getByTestId("composer-input")).toHaveValue("");
    const rows = page.getByTestId("queue-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-mode", "followUp");
    await expect(rows.first()).toContainText("1");
    await expect(rows.first()).toContainText("second question, queued while pi works");

    await sendQueued(page, "followUp", "third question");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("2");
    await expect(rows.nth(1)).toContainText("third question");
  });

  test("a long preview truncates instead of blowing up the bar", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    const long = "x".repeat(200);
    await sendQueued(page, "followUp", long);
    const preview = page.locator('[data-testid="queue-row"] .queue-preview');
    await expect(preview).toContainText("…");
    const text = await preview.textContent();
    expect(text!.length).toBeLessThanOrEqual(121);
  });

  test("sending while idle never queues", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("direct send");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);
    await expect(page.getByTestId("queue-bar")).toHaveCount(0);
    await waitSettled(page);
    await expect(page.getByTestId("queue-bar")).toHaveCount(0);
  });

  test("an image travels with the entry and shows as a marker", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await page.setInputFiles('input[type="file"]', {
      name: "queue-pic.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expect(page.getByTestId("image-chips")).toContainText("queue-pic.png");
    await sendQueued(page, "followUp", "redo this chart");
    await expect(page.getByTestId("queue-row")).toHaveCount(1);
    await expect(page.getByTestId("queue-image-count")).toContainText("1");
  });

  // -- US2: pi consumes in order, the plugin never re-fires --------------------

  test("pi drains follow-ups one at a time and the bar renumbers", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("run one");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await sendQueued(page, "followUp", "queued two");
    await sendQueued(page, "followUp", "queued three");
    await expect(page.getByTestId("queue-row")).toHaveCount(2);

    // The first run settles → pi starts "queued two" as its own turn; the bar
    // must show exactly one remaining entry, renumbered to 1.
    await expect(page.getByTestId("queue-row")).toHaveCount(1, { timeout: 40_000 });
    await expect(page.getByTestId("queue-row")).toContainText("queued three");
    await expect(page.getByTestId("queue-row")).toContainText("1");

    // Everything drains without the plugin firing anything extra: three user
    // turns total, and an empty bar at the end.
    await expect(page.getByTestId("queue-bar")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId("item-user")).toHaveCount(3);
  });

  // -- US3: take-back into the composer ----------------------------------------

  test("edit returns text and image to the composer, draft kept", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await page.setInputFiles('input[type="file"]', {
      name: "edit-pic.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await sendQueued(page, "followUp", "take me back");
    await page.getByTestId("composer-input").fill("existing draft");
    await page.getByTestId("queue-edit-0").click();

    // Draft kept, content appended after a blank line, image chip back.
    await expect(page.getByTestId("composer-input")).toHaveValue("existing draft\n\ntake me back");
    await expect(page.getByTestId("image-chips")).toContainText("image-1");
    await expect(page.getByTestId("queue-bar")).toHaveCount(0);

    // It can be sent again — it queues just like before.
    await sendQueued(page, "followUp", "take me back");
    await expect(page.getByTestId("queue-row")).toHaveCount(1);
  });

  test("editing the last remaining entry collapses the bar", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await sendQueued(page, "followUp", "only one");
    await expect(page.getByTestId("queue-row")).toHaveCount(1);
    await page.getByTestId("queue-edit-0").click();
    await expect(page.getByTestId("queue-bar")).toHaveCount(0);
  });

  // -- US4: reorder and delete --------------------------------------------------

  test("move up swaps neighbours and renumbers; edges are disabled", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await sendQueued(page, "followUp", "alpha");
    await sendQueued(page, "followUp", "beta");
    await sendQueued(page, "followUp", "gamma");
    const rows = page.getByTestId("queue-row");
    await expect(rows).toHaveCount(3);

    await expect(page.getByTestId("queue-up-0")).toBeDisabled();
    await expect(page.getByTestId("queue-down-2")).toBeDisabled();

    await page.getByTestId("queue-up-1").click();
    await expect(rows.nth(0)).toContainText("beta");
    await expect(rows.nth(1)).toContainText("alpha");
    await expect(rows.nth(2)).toContainText("gamma");
  });

  test("delete needs the inline confirm and renumbers after it", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await sendQueued(page, "followUp", "keep me");
    await sendQueued(page, "followUp", "delete me");
    const rows = page.getByTestId("queue-row");
    await expect(rows).toHaveCount(2);

    // First click only arms the row; cancel restores the plain button.
    await page.getByTestId("queue-del-1").click();
    await expect(page.getByTestId("queue-confirm-del-1")).toBeVisible();
    await page.getByTestId("queue-cancel-del-1").click();
    await expect(page.getByTestId("queue-confirm-del-1")).toHaveCount(0);
    await expect(rows).toHaveCount(2);

    // Confirming removes exactly that row and renumbers the rest.
    await page.getByTestId("queue-del-1").click();
    await page.getByTestId("queue-confirm-del-1").click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("keep me");
    await expect(rows.first()).toContainText("1");
  });

  test("an armed delete reverts on its own", async ({ page }) => {
    test.slow();
    await open(page);
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await sendQueued(page, "followUp", "still here");
    await expect(page.getByTestId("queue-row")).toHaveCount(1);

    await page.getByTestId("queue-del-0").click();
    await expect(page.getByTestId("queue-confirm-del-0")).toBeVisible();
    // 2.5s auto-revert (plan decision 6) — the destructive button must not
    // stay armed forever.
    await expect(page.getByTestId("queue-confirm-del-0")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId("queue-row")).toHaveCount(1);
  });

  // -- US5: steer ---------------------------------------------------------------

  test("steer fires a marked user message and drains from the queue", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("long running task");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    // Streaming defaults the mode to steer; send explicitly anyway.
    await sendQueued(page, "steer", "wait — check the tests first");
    await expect(page.getByTestId("steer-tag")).toBeVisible();
    await expect(page.getByTestId("queue-row").first()).toHaveAttribute("data-mode", "steer");

    // pi injects it at the turn boundary → the bar empties, and the injected
    // message shows up as a real user message next to the fire trace.
    await expect(page.getByTestId("queue-bar")).toHaveCount(0, { timeout: 40_000 });
    await waitSettled(page);
  });

  test("a failed steer stays visible, marked and with the raw error", async ({ page }) => {
    await open(page, "queuefail=enqueue");
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await sendQueued(page, "steer", "this one fails");
    const row = page.getByTestId("queue-row").first();
    await expect(row).toHaveAttribute("data-status", "failed");
    await expect(page.getByTestId("queue-error")).toContainText("model endpoint is unavailable");
  });

  // -- US6: promote a follow-up to a steer --------------------------------------

  test("promote moves the entry into the steer section, others keep their order", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await sendQueued(page, "followUp", "first");
    await sendQueued(page, "followUp", "second");
    await sendQueued(page, "followUp", "third");
    const rows = page.getByTestId("queue-row");
    await expect(rows).toHaveCount(3);

    await page.getByTestId("queue-promote-1").click();
    // The promoted entry now sits in the steer section (top), the rest in order.
    await expect(rows.nth(0)).toHaveAttribute("data-mode", "steer");
    await expect(rows.nth(0)).toContainText("second");
    await expect(rows.nth(1)).toHaveAttribute("data-mode", "followUp");
    await expect(rows.nth(1)).toContainText("first");
    await expect(rows.nth(2)).toContainText("third");
  });

  // -- US7: pause / resume / confirmations / reload ------------------------------

  test("abort parks the queue, nothing fires, resume re-enqueues in order", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("abort me");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await sendQueued(page, "followUp", "parked while aborted");
    await page.getByTestId("abort-btn").click();
    await waitSettled(page);

    const banner = page.getByTestId("queue-paused");
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId("queue-resume")).toBeVisible();

    // Nothing may fire while parked.
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId("queue-row")).toHaveCount(1);
    await expect(page.getByTestId("item-user")).toHaveCount(1);

    // 继续 re-enqueues in order; idle pi starts it right away.
    await page.getByTestId("queue-resume").click();
    await expect(page.getByTestId("queue-bar")).toHaveCount(0, { timeout: 40_000 });
    await waitSettled(page);
    await expect(page.getByTestId("item-user")).toHaveCount(2);
  });

  test("清空 from the paused banner drops everything", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("abort me too");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);

    await sendQueued(page, "followUp", "never mind");
    await page.getByTestId("abort-btn").click();
    await expect(page.getByTestId("queue-paused")).toBeVisible({ timeout: 10_000 });

    await page.getByTestId("queue-clear").click();
    await expect(page.getByTestId("queue-bar")).toHaveCount(0);
  });

  test("switching sessions with a non-empty queue asks first (FR-012)", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);
    await sendQueued(page, "followUp", "do not lose me");

    await page.getByTestId("tab-sessions").click();
    await page.locator('[data-testid="session-row"] button').first().click();
    const confirm = page.getByTestId("queue-discard-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("1");

    // Cancel keeps the queue exactly as it was.
    await page.getByTestId("queue-discard-no").click();
    await expect(confirm).toHaveCount(0);
    await page.getByTestId("tab-chat").click();
    await expect(page.getByTestId("queue-row")).toHaveCount(1);

    // Confirming discards and switches.
    await page.getByTestId("tab-sessions").click();
    await page.locator('[data-testid="session-row"] button').first().click();
    await page.getByTestId("queue-discard-yes").click();
    await expect(page.getByTestId("queue-bar")).toHaveCount(0);
    await expect(page.getByTestId("manage-view")).toHaveCount(0); // chat tab active
  });

  test("the queue survives a reload (FR-001 restore)", async ({ page }) => {
    await open(page);
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await waitStreaming(page);
    await sendQueued(page, "followUp", "survives reload one");
    await sendQueued(page, "followUp", "survives reload two");
    await expect(page.getByTestId("queue-row")).toHaveCount(2);

    await page.reload();
    await expect(page.getByTestId("empty-state")).toBeVisible();
    const rows = page.getByTestId("queue-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("survives reload one");
    await expect(rows.nth(1)).toContainText("survives reload two");
  });
});
