import { expect, test, type Page } from "@playwright/test";

/**
 * Message-level actions: copy / quote / regenerate / edit-and-resend.
 *
 * All of it runs against the MockBridge, so the assertions are about what the
 * user sees plus the clipboard — the RPC order is covered by store.test.ts.
 */

const FINAL_MARKER = "hello from mock pi";

/** Windows puts CRLF on the clipboard; the source uses LF. */
const normalize = (clip: string) => clip.replace(/\r\n/g, "\n");

const assistantItems = (page: Page) => page.getByTestId("item-assistant");
const userItems = (page: Page) => page.getByTestId("item-user");

/**
 * A settled run. The idle check has to come *after* seeing the busy state:
 * asserting "not busy" alone is satisfied instantly, before the run even
 * starts, which makes every later assertion race the stream.
 */
async function settle(page: Page) {
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

async function ask(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
}

async function askAndSettle(page: Page, text: string) {
  await ask(page, text);
  await settle(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

// ---------------------------------------------------------------------------
// US1 — copy
// ---------------------------------------------------------------------------

test("the toolbar appears on hover and disappears when the pointer leaves", async ({ page }) => {
  await askAndSettle(page, "hello there");

  const assistant = assistantItems(page).last();
  const toolbar = assistant.getByTestId("msg-actions");

  // Resting state: present in the DOM, invisible — a hover-only affordance.
  await expect(toolbar).toBeHidden();

  await assistant.hover();
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByTestId("act-copy")).toBeVisible();

  // Hovering anywhere else in the list hides it again.
  await userItems(page).first().hover();
  await expect(toolbar).toBeHidden();
});

test("copying a reply puts its Markdown source on the clipboard, never the thinking text", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await askAndSettle(page, "run the tests");

  const assistant = assistantItems(page).last();
  await assistant.hover();
  const copyBtn = assistant.getByTestId("act-copy");
  await copyBtn.click();

  // Success is visible and self-clearing (FR-004).
  await expect(copyBtn).toHaveAttribute("data-state", "ok");
  await expect(copyBtn).toHaveAttribute("data-state", "idle", { timeout: 5_000 });

  const clip = normalize(await page.evaluate(() => navigator.clipboard.readText()));
  expect(clip).toContain("```bash\necho hello from mock pi\n```");
  expect(clip).toContain("Also see src/main.tsx");
  // The reasoning is not part of the message source.
  expect(clip).not.toContain("Let me check the project first");
  // The fenced block survives verbatim: this is Markdown, not rendered text.
  expect(clip).not.toContain("Copy");
});

test("copying a user message keeps its line breaks character-exact", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await askAndSettle(page, "line one\nline two");

  const user = userItems(page).first();
  await user.hover();
  await user.getByTestId("act-copy").click();

  const clip = normalize(await page.evaluate(() => navigator.clipboard.readText()));
  expect(clip).toBe("line one\nline two");
});

test("a failed send is copyable so it can go into a bug report", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  // The mock rejects this one prompt, which is the only way to get an
  // item-error into the transcript from the UI.
  await page.goto("/?fail=prompt");
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await ask(page, "this will fail");

  const error = page.locator('[data-testid="system-item"].item-error').last();
  await expect(error).toBeVisible({ timeout: 10_000 });
  await error.hover();
  await error.getByTestId("act-copy").click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("Failed to send");
  expect(clip).toContain("model endpoint is unavailable");
  // Error items get copy only: there is nothing to quote or regenerate.
  await expect(error.getByTestId("act-quote")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// US2 — quote
// ---------------------------------------------------------------------------

test("quote prefills the composer as a blockquote and focuses it", async ({ page }) => {
  await askAndSettle(page, "explain the store");
  const input = page.getByTestId("composer-input");

  const assistant = assistantItems(page).last();
  await assistant.hover();
  await assistant.getByTestId("act-quote").click();

  await expect(input).toBeFocused();
  await expect(input).toHaveValue(/^> /);
  const value = await input.inputValue();
  expect(value.startsWith("> ")).toBe(true);
  expect(value).toContain("> The command printed");
  // Multi-line content is quoted line by line, so it stays one block.
  expect(value).toContain('\n> ```bash');
});

test("quote appends to the draft instead of overwriting it (FR-006)", async ({ page }) => {
  await askAndSettle(page, "explain the store");
  const input = page.getByTestId("composer-input");
  await input.fill("my draft");

  const user = userItems(page).first();
  await user.hover();
  await user.getByTestId("act-quote").click();

  // The prefill lands one render after the click, so retry rather than read.
  await expect(input).toHaveValue(/^my draft\n\n> /);
  const value = await input.inputValue();
  expect(value).toContain("> explain the store");
});

// ---------------------------------------------------------------------------
// US3 — regenerate
// ---------------------------------------------------------------------------

test("regenerate replaces the reply with a fresh answer", async ({ page }) => {
  await askAndSettle(page, "explain the store");
  const assistant = assistantItems(page).last();
  await expect(assistant).toContainText(FINAL_MARKER);

  await assistant.hover();
  await assistant.getByTestId("act-regenerate").click();
  await settle(page);

  // The mock answers the same prompt differently on the second pass, so a
  // second take is proof the transcript really branched instead of re-rendering.
  const regenerated = assistantItems(page).last();
  await expect(regenerated).toContainText("Regenerated answer, take 2", { timeout: 30_000 });
  await expect(page.getByText("Regenerated answer, take 2")).toHaveCount(1);
});

test("regenerate is not offered on a reply that is still streaming (FR-001)", async ({ page }) => {
  await ask(page, "explain the store");

  const streaming = assistantItems(page).last();
  await expect(streaming).toBeVisible({ timeout: 20_000 });
  await streaming.hover();
  // Either no toolbar at all, or one without regenerate — both mean "not yet".
  await expect(streaming.getByTestId("act-regenerate")).toHaveCount(0);
});

test("regenerate and edit are disabled while a run is in flight (FR-010)", async ({ page }) => {
  await askAndSettle(page, "first question");
  await ask(page, "second question");
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });

  // The reply above is finished, so it gets copy/quote — but not regenerate,
  // because regenerating mid-run would rewrite the branch being written to.
  const settledReply = assistantItems(page).first();
  await settledReply.hover();
  await expect(settledReply.getByTestId("act-quote")).toBeVisible();
  await expect(settledReply.getByTestId("act-regenerate")).toHaveCount(0);
  await expect(userItems(page).first().getByTestId("act-edit")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// US4 — edit and resend
// ---------------------------------------------------------------------------

test("edit refills the composer, flags the mode, and resend rewrites the message", async ({ page }) => {
  await askAndSettle(page, "explain the store");
  const input = page.getByTestId("composer-input");

  const user = userItems(page).first();
  await user.hover();
  await user.getByTestId("act-edit").click();

  // The draft is the message itself, so the banner has to say so.
  await expect(input).toHaveValue("explain the store");
  await expect(page.getByTestId("edit-mode-note")).toBeVisible();
  await expect(input).toBeFocused();

  await input.fill("explain the composer");
  await page.getByTestId("send-btn").click();

  await expect(userItems(page).first()).toContainText("explain the composer");
  await expect(page.getByTestId("edit-mode-note")).toBeHidden();
  // The old version and the answer it produced are gone: the branch dropped
  // them, so nothing on screen still mentions the old prompt.
  await expect(page.getByText("explain the store")).toHaveCount(0);
  await settle(page);
  // The rewritten prompt is what pi was asked, so the new answer echoes it.
  await expect(assistantItems(page).first()).toContainText("explain the composer", {
    timeout: 30_000,
  });
});

test("edit only appears on the last user message (FR-009)", async ({ page }) => {
  await askAndSettle(page, "first question");
  await askAndSettle(page, "second question");

  const users = userItems(page);
  await expect(users).toHaveCount(2);
  await users.first().hover();
  await expect(users.first().getByTestId("act-edit")).toHaveCount(0);
  await users.last().hover();
  await expect(users.last().getByTestId("act-edit")).toBeVisible();
});

test("cancelling an edit leaves the conversation untouched (US4-3)", async ({ page }) => {
  await askAndSettle(page, "explain the store");
  const before = await userItems(page).count();

  await userItems(page).first().hover();
  await userItems(page).first().getByTestId("act-edit").click();
  await expect(page.getByTestId("edit-mode-note")).toBeVisible();

  await page.getByTestId("composer-input").press("Escape");

  await expect(page.getByTestId("composer-input")).toHaveValue("");
  await expect(page.getByTestId("edit-mode-note")).toBeHidden();
  // Nothing was forked, replayed or deleted: the message is still there.
  await expect(userItems(page)).toHaveCount(before);
  await expect(userItems(page).first()).toContainText("explain the store");
});
