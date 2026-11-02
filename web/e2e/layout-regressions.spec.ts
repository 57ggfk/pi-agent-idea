import { expect, test } from "@playwright/test";

/**
 * Regression guards for docs/UI_ISSUES.md.
 *
 * Every bug in that list shipped green: `toBeVisible()` only asks for a non-empty
 * bounding box, so a menu rendered *above the tool window* or a session card
 * clipped by `overflow: hidden` still passed. These assertions measure geometry
 * against the tool window (`.app`) instead.
 */

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

const boxOf = (page: import("@playwright/test").Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
  }, selector);

/** #1 — a menu positioned against the wrong containing block landed above the
 *  window: it existed, it was "visible", nobody could see it. */
for (const [name, trigger] of [
  ["@ file", "@"],
  ["/ command", "/"],
] as const) {
  test(`${name} menu opens on screen, above the composer`, async ({ page }) => {
    await page.setViewportSize({ width: 680, height: 760 });
    await page.goto("/");
    await page.getByTestId("composer-input").pressSequentially(trigger);

    const menuSel = name === "@ file" ? '[data-testid="file-menu"]' : '[data-testid="slash-menu"]';
    await expect(page.locator(menuSel)).toBeVisible();

    const menu = (await boxOf(page, menuSel)) as Box;
    const box = (await boxOf(page, ".composer-box")) as Box;
    const app = (await boxOf(page, ".app")) as Box;

    // Inside the window, not above its top edge.
    expect(menu.top, "menu starts above the tool window").toBeGreaterThanOrEqual(app.top - 1);
    expect(menu.bottom, "menu is not attached to the composer").toBeLessThanOrEqual(box.top + 1);
    expect(menu.height).toBeGreaterThan(0);
    expect(menu.left).toBeGreaterThanOrEqual(app.left);
    expect(menu.right).toBeLessThanOrEqual(app.right);
  });
}

test("a query with no match says so instead of closing silently", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 760 });
  await page.goto("/");
  await page.getByTestId("composer-input").pressSequentially("@zzzz-no-such-file");
  await expect(page.getByTestId("file-menu-empty")).toBeVisible();
});

test("@ completion also triggers after a CJK character", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 760 });
  await page.goto("/");
  const input = page.getByTestId("composer-input");
  await input.pressSequentially("看@sto");
  const menu = page.getByTestId("file-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".file-item").first()).toContainText("src/store/store.ts");
});

/** #2 — the menu was pinned at 280px and opened off a mid-row button, so the
 *  switches ended up outside the tool window (and outside the clipping rect). */
for (const width of [360, 430, 520, 900]) {
  test(`options menu and its switches stay inside the window at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/");
    await page.getByTestId("options-btn").click();
    await expect(page.getByTestId("options-menu")).toBeVisible();

    const r = await page.evaluate(() => {
      const menu = document.querySelector('[data-testid="options-menu"]')!;
      const app = document.querySelector(".app")!.getBoundingClientRect();
      const rect = (el: Element) => {
        const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top };
      };
      return {
        menu: rect(menu),
        app,
        switches: Array.from(menu.querySelectorAll('[role="switch"]')).map(rect),
        segments: Array.from(menu.querySelectorAll('[data-testid^="opt-theme-"]')).map(rect),
        rows: Array.from(menu.querySelectorAll(".options-row")).map(rect),
        scrollHeight: menu.scrollHeight,
        clientHeight: menu.clientHeight,
      };
    });

    expect(r.menu.left).toBeGreaterThanOrEqual(r.app.left - 0.5);
    expect(r.menu.right).toBeLessThanOrEqual(r.app.right + 0.5);
    expect(r.menu.top).toBeGreaterThanOrEqual(r.app.top - 0.5);
    // The menu may scroll, but nothing inside may be clipped horizontally.
    expect(r.switches).toHaveLength(3);
    for (const s of [...r.switches, ...r.segments, ...r.rows]) {
      expect(s.left).toBeGreaterThanOrEqual(r.menu.left - 0.5);
      expect(s.right).toBeLessThanOrEqual(r.menu.right + 0.5);
    }
    // All three theme segments exist at every width.
    expect(r.segments).toHaveLength(3);
  });
}

/** #3 — `grid-template-columns: 1fr` let a long name widen the track and push
 *  the row's action buttons out of the clipped area. */
for (const width of [360, 430, 900]) {
  test(`session cards and their actions stay inside the panel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/");
    await page.getByTestId("tab-sessions").click();
    await expect(page.getByTestId("session-row").first()).toBeVisible();

    // Torture: a long unbroken name/preview must not widen the card.
    await page.evaluate(() => {
      const name = document.querySelector(".session-name");
      const preview = document.querySelector(".session-preview");
      if (name) name.textContent = "session-" + "x".repeat(120);
      if (preview) preview.textContent = "uuid " + "a".repeat(160);
    });

    const r = await page.evaluate(() => {
      const app = document.querySelector(".app")!.getBoundingClientRect();
      const list = document.querySelector(".sessions-list")!.getBoundingClientRect();
      const rows = Array.from(document.querySelectorAll(".session-row")).map((el) => {
        const b = el.getBoundingClientRect();
        const actions = el.querySelector(".session-actions")!.getBoundingClientRect();
        return { right: b.right, left: b.left, actionsRight: actions.right, actionsWidth: actions.width };
      });
      return { app, list, rows };
    });

    for (const row of r.rows) {
      expect(row.left).toBeGreaterThanOrEqual(r.list.left - 0.5);
      expect(row.right).toBeLessThanOrEqual(r.list.right + 0.5);
      expect(row.right).toBeLessThanOrEqual(r.app.right + 0.5);
      expect(row.actionsWidth).toBeGreaterThan(0);
      expect(row.actionsRight).toBeLessThanOrEqual(row.right + 0.5);
    }
  });
}

/** #4 — the `+ New session` button was removed from the Sessions toolbar. */
test("sessions toolbar only has the filter field", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("sessions-filter")).toBeVisible();
  await expect(page.locator(".sessions-toolbar button")).toHaveCount(0);
});

/** #5 / #6 — one axis for the message column and the composer, at every width,
 *  with the empty state dead-center and no document-level overflow. */
for (const width of [360, 680, 900, 1440]) {
  test(`message column, composer and empty state share one axis at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();

    const r = await page.evaluate(() => {
      const de = document.documentElement;
      const col = document.querySelector(".message-col")!.getBoundingClientRect();
      const comp = document.querySelector(".composer-inner")!.getBoundingClientRect();
      const logo = document.querySelector(".empty-logo")!.getBoundingClientRect();
      return {
        colLeft: col.left,
        colWidth: col.width,
        compLeft: comp.left,
        compWidth: comp.width,
        logoCenter: logo.left + logo.width / 2,
        viewportCenter: de.clientWidth / 2,
        overflow: de.scrollWidth - de.clientWidth,
        apps: document.querySelectorAll(".app").length,
      };
    });

    expect(r.colLeft).toBeCloseTo(r.compLeft, 0);
    expect(r.colWidth).toBeCloseTo(r.compWidth, 0);
    expect(r.logoCenter).toBeCloseTo(r.viewportCenter, 0);
    expect(r.overflow, "document overflows horizontally").toBeLessThanOrEqual(0);
    expect(r.apps, "more than one .app instance").toBe(1);
  });
}

/** #7 — `+` used to drop a running answer without asking. */
test("New confirms before discarding a running session", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("composer-input").fill("still working?");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });

  // The tooltip tells the truth while streaming.
  await expect(page.getByTestId("new-session")).toHaveAttribute("title", /discarded/);

  let asked = "";
  page.once("dialog", async (dialog) => {
    asked = dialog.message();
    await dialog.dismiss();
  });
  await page.getByTestId("new-session").click();

  await expect.poll(() => asked).toContain("still working");
  // Cancelled: the conversation is untouched.
  await expect(page.getByTestId("item-user").first()).toBeVisible();
  await expect(page.getByTestId("empty-state")).toHaveCount(0);
});
