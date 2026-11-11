import { expect, test, type Page } from "@playwright/test";

/**
 * Spec 007 US3 — one in-app confirmation dialog for every action that switches
 * away from or destroys the current view. The point of the component is that
 * nothing here reaches `window.confirm` any more (FR-007 / SC-003).
 */

async function sendAndWait(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

/** Counts native `window.confirm` / `alert` / `prompt` invocations. */
function countNativeDialogs(page: Page) {
  const seen: string[] = [];
  page.on("dialog", (d) => {
    seen.push(d.message());
    void d.dismiss();
  });
  return seen;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

/** T014 — the shell: role, aria, title and message. */
test("New opens an accessible in-app dialog", async ({ page }) => {
  await sendAndWait(page, "q1");

  await page.getByTestId("new-session").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toHaveAttribute("aria-labelledby", "confirm-title");
  await expect(page.getByTestId("confirm-title")).toHaveText(/start a new session/i);
  // FR-008: the body says what happens to the session you are leaving.
  await expect(page.getByTestId("confirm-message")).toContainText(/kept in sessions/i);
  await expect(page.getByTestId("confirm-ok")).toHaveText("Start new");
});

/** T015 — Esc cancels, Enter confirms, focus lands on the primary button. */
test("the dialog owns the keyboard: Esc cancels, Enter confirms", async ({ page }) => {
  await sendAndWait(page, "q1");

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("confirm-ok")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(page.getByTestId("item-user")).toHaveCount(1);

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("confirm-ok")).toBeFocused();
  await page.keyboard.press("Enter");
  // Confirmed: the session is emptied.
  await expect(page.getByTestId("empty-state")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("item-user")).toHaveCount(0);
});

/** T015 — Tab must not escape the dialog. */
test("Tab cycles inside the dialog instead of reaching the composer", async ({ page }) => {
  await sendAndWait(page, "q1");
  await page.getByTestId("new-session").click();

  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="confirm-dialog"]');
      return Boolean(dialog && dialog.contains(document.activeElement));
    });
    expect(inside, `focus escaped the dialog on Tab #${i + 1}`).toBe(true);
  }
});

/** T016 — geometry at the three supported widths, buttons on one row. */
for (const width of [360, 430, 900]) {
  test(`the dialog stays inside the tool window at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    await sendAndWait(page, "q1");
    await page.getByTestId("new-session").click();

    const r = await page.evaluate(() => {
      const app = document.querySelector(".app")!.getBoundingClientRect();
      const box = document.querySelector('[data-testid="confirm-dialog"]')!.getBoundingClientRect();
      const ok = document.querySelector('[data-testid="confirm-ok"]')!.getBoundingClientRect();
      const cancel = document.querySelector('[data-testid="confirm-cancel"]')!.getBoundingClientRect();
      return {
        inside:
          box.left >= app.left - 0.5 &&
          box.right <= app.right + 0.5 &&
          box.top >= app.top - 0.5 &&
          box.bottom <= app.bottom + 0.5,
        sameRow: Math.abs(ok.top - cancel.top) < 1,
        okHeight: ok.height,
        okWidth: ok.width,
      };
    });

    expect(r.inside, "dialog overflows the tool window").toBe(true);
    // SC-004: the two buttons never wrap onto two rows.
    expect(r.sameRow).toBe(true);
    expect(r.okWidth).toBeGreaterThan(40);
    expect(r.okHeight).toBeLessThan(40);
  });
}

/** T016 — the scrim swallows clicks and wheel events. */
test("the scrim closes on click and blocks scrolling behind it", async ({ page }) => {
  for (let i = 0; i < 6; i++) await sendAndWait(page, `question ${i}`);
  await page.evaluate(() => {
    const list = document.querySelector(".message-list")!;
    list.scrollTop = 0;
  });

  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();

  // Scrolling over the scrim must not move the message list behind it.
  await page.getByTestId("confirm-scrim").hover();
  await page.mouse.wheel(0, 400);
  const scrolled = await page.evaluate(() => document.querySelector(".message-list")!.scrollTop);
  expect(scrolled).toBe(0);

  // Clicking outside the box cancels.
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(page.getByTestId("item-user")).toHaveCount(6);
});

/** T018 / FR-011 — an empty session asks nothing. */
test("New on an empty session starts immediately without a dialog", async ({ page }) => {
  const native = countNativeDialogs(page);
  await page.getByTestId("new-session").click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(page.getByTestId("empty-state")).toBeVisible();
  expect(native).toHaveLength(0);
});

/** T017 — delete goes through the same component, with the danger action. */
test("deleting a session asks with the danger action", async ({ page }) => {
  const native = countNativeDialogs(page);
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row").first()).toBeVisible();

  await page.getByTestId("session-delete").first().click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(page.getByTestId("confirm-ok")).toHaveText("Delete");
  await expect(page.getByTestId("confirm-ok")).toHaveClass(/confirm-danger/);
  await expect(page.getByTestId("confirm-message")).toContainText(/cannot be undone/i);

  await page.getByTestId("confirm-cancel").click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  expect(native).toHaveLength(0);
});

/** SC-003 — nothing in Chat or Sessions reaches a native dialog. */
test("no native window.confirm survives in Chat or Sessions", async ({ page }) => {
  const native = countNativeDialogs(page);
  await sendAndWait(page, "q1");

  await page.getByTestId("new-session").click();
  await page.keyboard.press("Escape");

  // 023: Fork sits on the round's last reply, not on every pi reply.
  const reply = page.getByTestId("item-assistant").last();
  await reply.hover();
  await reply.getByTestId("act-fork").click();
  await page.keyboard.press("Escape");

  await page.getByTestId("tab-sessions").click();
  await page.getByTestId("session-delete").first().click();
  await page.keyboard.press("Escape");

  expect(native, `native dialogs fired: ${native.join(" | ")}`).toHaveLength(0);
});
