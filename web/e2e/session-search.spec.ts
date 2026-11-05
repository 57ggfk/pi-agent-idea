import { expect, test, type Page } from "@playwright/test";

/**
 * Spec 006 US2 — in-session search: Ctrl+F / toolbar button open the same
 * bar, Enter navigation wraps, Esc clears, tool cards auto-expand on a hit,
 * and the highlight never breaks the markdown layout.
 */

async function sendAndWait(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("Ctrl+F opens the search bar and keeps focus in it (FR-004)", async ({ page }) => {
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("search-bar")).toBeVisible();
  await expect(page.getByTestId("search-input")).toBeFocused();
});

test("the toolbar button opens the same search bar (FR-005)", async ({ page }) => {
  await page.getByTestId("search-btn").click();
  await expect(page.getByTestId("search-bar")).toBeVisible();
  await expect(page.getByTestId("search-input")).toBeFocused();
});

test("counting, wrap-around navigation and Esc clearing (US2 scenarios 3–6)", async ({ page }) => {
  await sendAndWait(page, "turn one");
  await sendAndWait(page, "turn two");
  await sendAndWait(page, "turn three");
  // The mock echoes the prompt into "sanity check" once per turn.
  await page.keyboard.press("Control+f");
  await page.getByTestId("search-input").fill("sanity");
  await expect(page.getByTestId("search-count")).toHaveText("1/3");

  await page.getByTestId("search-input").press("Enter");
  await expect(page.getByTestId("search-count")).toHaveText("2/3");
  await page.getByTestId("search-input").press("Enter");
  await expect(page.getByTestId("search-count")).toHaveText("3/3");
  await page.getByTestId("search-input").press("Enter");
  await expect(page.getByTestId("search-count")).toHaveText("1/3"); // wrap

  await page.getByTestId("search-input").press("Shift+Enter");
  await expect(page.getByTestId("search-count")).toHaveText("3/3"); // wrap back

  await page.getByTestId("search-input").press("Escape");
  await expect(page.getByTestId("search-bar")).toHaveCount(0);
  const highlights = await page.evaluate(() =>
    (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.size ?? 0,
  );
  expect(highlights).toBe(0);
});

test("a query without matches shows 0/0 and a plain 'No matches' note (scenario 5)", async ({ page }) => {
  await sendAndWait(page, "hello there");
  await page.keyboard.press("Control+f");
  await page.getByTestId("search-input").fill("nonexistent-token");
  await expect(page.getByTestId("search-count")).toHaveText("0/0");
  await expect(page.getByTestId("search-empty")).toContainText("No matches");
});

test("a hit inside tool output auto-expands the card (T011)", async ({ page }) => {
  await sendAndWait(page, "run the tool");
  await page.keyboard.press("Control+f");
  // "Patch applied" exists only in the edit tool's output pane.
  await page.getByTestId("search-input").fill("Patch applied");
  await expect(page.getByTestId("search-count")).toHaveText("1/1");
  // Exactly one card head is force-expanded by the search: the one holding
  // the hit (aria-expanded lives on .tool-card-head).
  await expect(page.locator('[data-testid="tool-card"] .tool-card-head[aria-expanded="true"]')).toHaveCount(1);
  await expect(page.locator(".tool-output").filter({ hasText: "Patch applied to src/main.tsx" })).toHaveCount(1);
});

test("search finds text that arrives during streaming (FR-009)", async ({ page }) => {
  await sendAndWait(page, "first turn");
  await page.keyboard.press("Control+f");
  await page.getByTestId("search-input").fill("sanity");
  await expect(page.getByTestId("search-count")).toHaveText("1/1");

  // Send while the search bar stays open; the second turn's "sanity check"
  // must join the result set (total 2/2) without reopening anything. The
  // current index stays on the first hit — the counter shows 1/2.
  await page.getByTestId("composer-input").fill("second turn");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("search-count")).toHaveText("1/2", { timeout: 30_000 });
});

test("search highlights do not break the markdown layout (T013)", async ({ page }) => {
  await sendAndWait(page, "layout probe");
  await page.keyboard.press("Control+f");
  await page.getByTestId("search-input").fill("sanity");
  await expect(page.getByTestId("search-count")).toHaveText("1/1");

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
  // The searched message keeps its markdown structure: the list survives.
  expect(await page.locator(".markdown ol li").count()).toBeGreaterThanOrEqual(2);
});

test("the overlay fallback paints one rect per hit when the Highlight API is absent (T010)", async ({ page }) => {
  // Simulate an old JCEF: no CSS.highlights, no Highlight constructor.
  await page.addInitScript(() => {
    Object.defineProperty(CSS, "highlights", { configurable: true, get: () => undefined });
    (window as unknown as { Highlight?: unknown }).Highlight = undefined;
  });
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await sendAndWait(page, "fallback turn one");
  await sendAndWait(page, "fallback turn two");
  await page.keyboard.press("Control+f");
  await page.getByTestId("search-input").fill("sanity");
  await expect(page.getByTestId("search-count")).toHaveText("1/2");
  await expect(page.getByTestId("search-hits-overlay")).toBeVisible();
  await expect(page.locator(".search-hit-rect")).toHaveCount(2);
});

test("switching sessions resets the search state (FR-015)", async ({ page }) => {
  await sendAndWait(page, "reset probe");
  await page.keyboard.press("Control+f");
  await page.getByTestId("search-input").fill("sanity");
  await expect(page.getByTestId("search-count")).toHaveText("1/1");

  // Fork the session (007's confirm dialog) — landing in another conversation
  // must not inherit the open search or its hits.
  const reply = page.getByTestId("item-assistant").last();
  await reply.hover();
  await reply.getByTestId("act-fork").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("search-bar")).toHaveCount(0);
  const highlights = await page.evaluate(() =>
    (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.size ?? 0,
  );
  expect(highlights).toBe(0);
});

// -- Full-session search (US3) -----------------------------------------------

test("Sessions search scans bodies, ranks hits and shows snippets (T017)", async ({ page }) => {
  await sendAndWait(page, "the uniq-token-abc plan");
  // Move to a fresh session so the hit lives in a *previous* session
  // (007's in-app confirm guards a session with content).
  await page.getByTestId("new-session").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("sessions-view")).toBeVisible();
  await page.getByTestId("sessions-filter").fill("uniq-token");
  const results = page.getByTestId("session-search-results");
  await expect(results).toBeVisible();
  const hit = page.getByTestId("session-search-hit").first();
  await expect(hit).toContainText("uniq-token-abc");
  await expect(page.getByTestId("session-hit-count").first()).toContainText(/hits?/);
  await expect(page.locator(".session-hit-mark").first()).toHaveText("uniq-token");
});

test("clicking a hit switches the session and lands on that hit (T018)", async ({ page }) => {
  await sendAndWait(page, "the jump-target-token plan");
  await page.getByTestId("new-session").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await page.getByTestId("tab-sessions").click();
  await page.getByTestId("sessions-filter").fill("jump-target-token");
  await expect(page.getByTestId("session-search-hit").first()).toBeVisible();
  await page.getByTestId("session-hit-snippet").first().click();

  // Back on the chat tab with the search bar open at the clicked hit.
  await expect(page.getByTestId("search-bar")).toBeVisible();
  await expect(page.getByTestId("search-input")).toHaveValue("jump-target-token");
  await expect(page.getByTestId("search-count")).toHaveText(/1\/\d/);
  await expect(page.getByTestId("tab-chat")).toHaveAttribute("aria-selected", "true");
});

test("a query with no matches says so and mentions the scan (T019)", async ({ page }) => {
  await sendAndWait(page, "a perfectly ordinary question");
  await page.getByTestId("tab-sessions").click();
  await page.getByTestId("sessions-filter").fill("zzz-no-such-token");
  await expect(page.getByTestId("sessions-search-empty")).toContainText("No matches in");
  await expect(page.getByTestId("sessions-search-empty")).toContainText("session");
});

test("a truncated scan says so instead of looking complete (T019)", async ({ page }) => {
  await page.goto("/?searchtruncate=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await sendAndWait(page, "truncation probe message");
  await page.getByTestId("tab-sessions").click();
  await page.getByTestId("sessions-filter").fill("truncation");
  await expect(page.getByTestId("sessions-search-truncated")).toContainText("stopped early");
});
