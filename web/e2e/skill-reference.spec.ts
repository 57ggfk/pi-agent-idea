import { test, expect, type Page } from "@playwright/test";

/**
 * Skill-reference display (011 US4, tasks T015–T018), driven by the mock's
 * `?skillref=1` knob: the mock rewrites `/skill:<name> …` prompts into pi's
 * expanded single-text-block message (T001 branch-b contract) before they
 * reach the transcript. The bubble must show only the `/skill:<name>` marker
 * plus the user's question — never the SKILL.md body — while copy, quote and
 * edit hand the folded form onward and the data layer keeps pi's raw text.
 */

const BODY_MARKER = "MOCK-SKILL-DEMO-BODY-MARKER-XYZ";

async function ask(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
  // The user bubble is also .markdown — settle on the assistant reply. Then
  // the run must be observed BUSY (abort button up) before observing it
  // settled (abort gone): abort=false alone is ambiguous — it also holds in
  // the window between the optimistic item and pi's agent_start, and sending
  // inside that window steer-queues the next ask.
  await expect(page.locator(".item-assistant").last()).toContainText("hello from mock pi", { timeout: 30_000 });
  await expect(page.getByTestId("abort-btn")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("abort-btn")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("queue-bar")).toHaveCount(0, { timeout: 15_000 });
}

test.describe("skill reference folding", () => {
  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/?skillref=1");
    await expect(page.getByTestId("empty-state")).toBeVisible();
  });

  test("bubble shows the marker + question; SKILL.md body never renders (T015)", async ({ page }) => {
    await ask(page, "/skill:demo-skill how do I use it");

    const user = page.getByTestId("item-user");
    await expect(user).toHaveCount(1); // optimistic raw + authoritative expanded dedupe to one
    await expect(user).toContainText("/skill:demo-skill how do I use it");
    await expect(user).not.toContainText(BODY_MARKER);
    // the whole transcript carries no body either
    await expect(page.getByTestId("message-list")).not.toContainText(BODY_MARKER);
  });

  test("copy and quote hand on the folded form, not the body (T016)", async ({ page }) => {
    await ask(page, "/skill:demo-skill how do I use it");

    // copy: clipboard holds the folded marker line only
    const user = page.getByTestId("item-user").first();
    await user.hover();
    await user.getByTestId("act-copy").click();
    await expect(user.getByTestId("act-copy")).toHaveAttribute("data-state", "ok");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe("/skill:demo-skill how do I use it");

    // quote: composer gets the folded text as a blockquote
    await user.hover();
    await user.getByTestId("act-quote").click();
    await expect(page.getByTestId("composer-input")).toHaveValue("> /skill:demo-skill how do I use it");
    await page.getByTestId("composer-input").fill("");
  });

  test("editing the referenced message puts the folded form back in the composer (T016)", async ({ page }) => {
    await ask(page, "/skill:demo-skill first ask");

    const user = page.getByTestId("item-user").first();
    const editBtn = user.getByTestId("act-edit");
    await user.hover();
    // the toolbar re-renders once the run fully settles
    await expect(editBtn).toBeAttached({ timeout: 15_000 });
    await editBtn.click();
    await expect(page.getByTestId("composer-input")).toHaveValue("/skill:demo-skill first ask");
    // leave edit mode without sending: Esc is edit-cancel (007 US4)
    await page.getByTestId("composer-input").press("Escape");
  });

  test("two references fold independently; a plain message never folds (T017)", async ({ page }) => {
    await ask(page, "/skill:demo-skill first");
    await ask(page, "/skill:second-skill second");

    const users = page.getByTestId("item-user");
    await expect(users).toHaveCount(2);
    await expect(users.nth(0)).toContainText("/skill:demo-skill first");
    await expect(users.nth(1)).toContainText("/skill:second-skill second");
    await expect(page.getByTestId("message-list")).not.toContainText("MOCK-SKILL-SECOND-BODY-MARKER");

    // a bare skill reference (no question) folds to the marker alone
    await ask(page, "/skill:demo-skill");
    await expect(users.nth(2)).toContainText("/skill:demo-skill");
    await expect(users.nth(2)).not.toContainText(BODY_MARKER);

    // handwritten prose mentioning the command passes through verbatim
    await ask(page, "how does the /skill: syntax work?");
    await expect(page.getByTestId("item-user").nth(3)).toContainText("how does the /skill: syntax work?");
  });

  test("session search still reaches the raw expanded body (T018)", async ({ page }) => {
    await ask(page, "/skill:demo-skill searchable question");

    await page.keyboard.press("Control+f");
    await page.getByTestId("search-input").fill(BODY_MARKER);
    // the store keeps pi's raw text, so the body IS findable — folding is
    // presentation-only (Non-goals: search/export keep the full原文)
    await expect(page.getByTestId("search-count")).toHaveText("1/1");
  });
});
