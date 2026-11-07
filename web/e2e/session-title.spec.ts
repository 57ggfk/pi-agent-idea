import { test, expect, type Page } from "@playwright/test";

/**
 * Session titles (012 US1, tasks T105–T109 + the B-stage LLM refinement).
 * pi never names sessions (T101 evidence), so the first user message becomes
 * the title (written back via set_session_name); once the first assistant
 * reply is in, a one-shot pi process (bridge title.generate) refines it, and
 * A's truncation stays on any failure. The status bar title is click-editable
 * and every session row carries the same editor — the live session through
 * pi, other rows through the bridge's sessions.rename. The store keeps list
 * rows in sync without extra refreshes, and a hand-set title beats both pi
 * name events and the refinement.
 */

async function ask(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
  await expect(page.locator(".item-assistant").last()).toContainText("hello from mock pi", { timeout: 30_000 });
  await expect(page.getByTestId("abort-btn")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("abort-btn")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("queue-bar")).toHaveCount(0, { timeout: 15_000 });
}

test.describe("session titles", () => {
  test("the first message titles the session, then the LLM refinement lands (T105/T109 + B)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();

    await ask(page, "help me refactor the login flow");

    // Stage B rewrites A's truncation through the mock title.generate — the
    // final title is the mock's answer, and the list row follows it.
    const status = page.getByTestId("status-session");
    await expect(status).toHaveText("Mock: help me refactor the", { timeout: 15_000 });

    await page.getByTestId("tab-sessions").click();
    const currentRow = page.locator('[data-testid="session-row"].session-current');
    await expect(currentRow.locator(".session-name")).toHaveText("Mock: help me refactor the");
  });

  test("a skill-expanded first message titles with the question — A folds, B refines (T109 + 011 US4)", async ({ page }) => {
    await page.goto("/?skillref=1");
    await expect(page.getByTestId("empty-state")).toBeVisible();

    await ask(page, "/skill:demo-skill how do I use it");
    // the excerpt sent to title.generate carries the folded question, so the
    // mock's answer is built from it — the SKILL.md body never reaches B
    await expect(page.getByTestId("status-session")).toHaveText("Mock: how do I use it", { timeout: 15_000 });
  });

  test("row rename: Enter commits, Esc cancels, empty is refused with a visible error (T107)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("tab-sessions").click();
    await expect(page.getByTestId("sessions-view")).toBeVisible();

    const currentRow = page.locator('[data-testid="session-row"].session-current');
    await currentRow.getByTestId("session-rename").click();
    const input = page.getByTestId("session-rename-input");
    await expect(input).toBeVisible();
    // exactly one editor exists anywhere
    await expect(page.locator(".session-title-input")).toHaveCount(1);

    // empty value: visible error, nothing committed, old name kept
    await input.fill("");
    await input.press("Enter");
    await expect(page.getByTestId("session-rename-error")).toBeVisible();

    // Esc leaves edit mode without touching the name
    await input.fill("draft that never lands");
    await input.press("Escape");
    await expect(page.getByTestId("session-rename-input")).toHaveCount(0);
    await expect(currentRow.locator(".session-name")).toHaveText("Refactor auth module");

    // Enter commits and both views agree
    await currentRow.getByTestId("session-rename").click();
    await page.getByTestId("session-rename-input").fill("Renamed by row");
    await page.getByTestId("session-rename-input").press("Enter");
    await expect(currentRow.locator(".session-name")).toHaveText("Renamed by row", { timeout: 15_000 });
    await page.getByTestId("tab-chat").click();
    await expect(page.getByTestId("status-session")).toHaveText("Renamed by row");
  });

  test("every row carries the pencil: a non-current row renames without switching (012 T107)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("tab-sessions").click();
    await expect(page.getByTestId("sessions-view")).toBeVisible();

    // both rows show the pencil; the current row is not the one under edit
    await expect(page.getByTestId("session-rename")).toHaveCount(2);
    const otherRow = page
      .locator('[data-testid="session-row"]')
      .filter({ hasText: "Fix the failing tests in CI" });
    await otherRow.getByTestId("session-rename").click();

    const input = page.getByTestId("session-rename-input");
    await expect(input).toBeVisible();
    // an unnamed session prefills what the row already shows — the title
    // auto-titling would have derived from the first message — never blank
    await expect(input).toHaveValue("Fix the failing tests in CI");
    await expect(page.locator(".session-title-input")).toHaveCount(1);

    await input.fill("Renamed offline row");
    await input.press("Enter");
    await expect(otherRow.locator(".session-name")).toHaveText("Renamed offline row", { timeout: 15_000 });
    await expect(page.getByTestId("session-rename-input")).toHaveCount(0);

    // the live session was neither switched to nor renamed
    const currentRow = page.locator('[data-testid="session-row"].session-current');
    await expect(currentRow.locator(".session-name")).toHaveText("Refactor auth module");
  });

  test("status-bar rename syncs the session list; never two editors (T108)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    // a title must exist before it can be edited — the first ask names the session
    await ask(page, "seed the session title");

    await page.getByTestId("status-session").click();
    const input = page.getByTestId("status-session-edit");
    await expect(input).toBeVisible();
    await expect(page.locator(".session-title-input")).toHaveCount(1);

    await input.fill("Renamed from status bar");
    await input.press("Enter");
    await expect(page.getByTestId("status-session")).toHaveText("Renamed from status bar", { timeout: 15_000 });

    await page.getByTestId("tab-sessions").click();
    const currentRow = page.locator('[data-testid="session-row"].session-current');
    await expect(currentRow.locator(".session-name")).toHaveText("Renamed from status bar");
    // switching tabs closed the editor — the status bar hosts it on other tabs
    await expect(page.getByTestId("status-session-edit")).toHaveCount(0);
  });

  test("a hand rename survives later pi name events (T106, store-backed)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await ask(page, "seed the session title");

    await page.getByTestId("status-session").click();
    await page.getByTestId("status-session-edit").fill("Manual wins");
    await page.getByTestId("status-session-edit").press("Enter");
    await expect(page.getByTestId("status-session")).toHaveText("Manual wins", { timeout: 15_000 });

    // the mock echoes set_session_name as session_info_changed; the store must
    // keep the manual title. Reopen the editor to prove the value is stable.
    await page.getByTestId("status-session").click();
    await expect(page.getByTestId("status-session-edit")).toHaveValue("Manual wins");
    await page.getByTestId("status-session-edit").press("Escape");
  });
});
