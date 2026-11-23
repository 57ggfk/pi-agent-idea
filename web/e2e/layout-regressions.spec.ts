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

/** Found on the real machine (20+ sessions): auto rows inside a
 *  definite-height grid got COMPRESSED to fit — every card shrank to ~36px
 *  and the name/preview lines clipped. Rows must keep their content height
 *  and the list must scroll instead. The mock seeds only 2 sessions, so this
 *  test injects enough rows to overflow the panel first. */
test("session cards keep their content height when the list overflows", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 600 });
  await page.goto("/");
  await page.getByTestId("tab-sessions").click();
  await expect(page.getByTestId("session-row").first()).toBeVisible();

  // 24 rows guarantees overflow at 600px panel height even on wide screens.
  await page.evaluate(() => {
    const first = document.querySelector('[data-testid="session-row"]')!;
    const list = document.querySelector(".sessions-list")!;
    for (let i = 0; i < 24; i++) {
      const clone = first.cloneNode(true) as HTMLElement;
      clone.querySelector(".session-name")!.textContent = `bulk session ${i}`;
      list.appendChild(clone);
    }
  });

  const r = await page.evaluate(() => {
    const list = document.querySelector(".sessions-list")!;
    const row = document.querySelector('[data-testid="session-row"]')!;
    const preview = row.querySelector(".session-preview")!;
    const pr = preview.getBoundingClientRect();
    const rowBottom = row.getBoundingClientRect().bottom;
    return {
      rowH: Math.round(row.getBoundingClientRect().height),
      previewH: Math.round(pr.height),
      previewBottomInsideRow: Math.round(pr.bottom) <= Math.round(rowBottom) + 1,
      listScrollable: list.scrollHeight - list.clientHeight > 100,
    };
  });

  // Two content lines (name + 2-line preview) need ~76px; a compressed card
  // measures ~36px.
  expect(r.rowH).toBeGreaterThanOrEqual(60);
  expect(r.previewH).toBeGreaterThanOrEqual(30);
  expect(r.previewBottomInsideRow, "preview line clipped by the card").toBe(true);
  expect(r.listScrollable, "the list must scroll instead of compressing rows").toBe(true);
});

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

/** #8 — the hover toolbar is absolutely positioned on purpose. If it ever took
 *  part in layout, hovering would reflow the list and shift the message under
 *  the cursor; if it were positioned off the wrong ancestor it would be clipped
 *  by `.message-list`'s horizontal overflow and drag the column sideways. */
for (const width of [360, 680, 900]) {
  test(`message toolbar stays inside the window without moving the message at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/");
    await page.getByTestId("composer-input").fill("measure the toolbar");
    await page.getByTestId("send-btn").click();
    // Busy first, then idle: "not busy" alone is true before the run starts.
    await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
    await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });

    for (const role of ["user", "assistant"] as const) {
      const item = page.locator(`[data-testid="item-${role}"]`).last();
      // Scroll first, then measure: hovering must not be what brings it into
      // view, otherwise the rect comparison below would compare two scrolls.
      await item.scrollIntoViewIfNeeded();
      const before = (await item.boundingBox())!;

      await item.hover();
      await expect(item.getByTestId("msg-actions")).toBeVisible();

      const r = await page.evaluate((role) => {
        const all = document.querySelectorAll(`[data-testid="item-${role}"]`);
        const el = all[all.length - 1]!;
        const app = document.querySelector(".app")!.getBoundingClientRect();
        const bar = el.querySelector('[data-testid="msg-actions"]')!.getBoundingClientRect();
        const itemBox = el.getBoundingClientRect();
        const list = document.querySelector(".message-list")!;
        return {
          app: { left: app.left, right: app.right, top: app.top, bottom: app.bottom },
          bar: { left: bar.left, right: bar.right, top: bar.top, bottom: bar.bottom, width: bar.width },
          item: { left: itemBox.left, top: itemBox.top, width: itemBox.width, height: itemBox.height },
          overflowX: list.scrollWidth - list.clientWidth,
        };
      }, role);

      // Inside the tool window on all four edges.
      expect(r.bar.left, "toolbar overflows left").toBeGreaterThanOrEqual(r.app.left - 0.5);
      expect(r.bar.right, "toolbar overflows right").toBeLessThanOrEqual(r.app.right + 1);
      expect(r.bar.top, "toolbar overflows the top").toBeGreaterThanOrEqual(r.app.top - 1);
      expect(r.bar.bottom, "toolbar overflows the bottom").toBeLessThanOrEqual(r.app.bottom + 1);
      expect(r.bar.width).toBeGreaterThan(0);

      // No horizontal scrollbar appears in the list.
      expect(r.overflowX, "the message list scrolls sideways").toBeLessThanOrEqual(0);

      // The message did not move: same rect before and after the hover.
      expect(r.item.left).toBeCloseTo(before.x, 0);
      expect(r.item.top).toBeCloseTo(before.y, 0);
      expect(r.item.width).toBeCloseTo(before.width, 0);
      expect(r.item.height).toBeCloseTo(before.height, 0);
    }
  });
}

/** #7 — `+` used to drop a running answer without asking. */
test("New confirms before discarding a running session", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("composer-input").fill("still working?");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });

  // The tooltip tells the truth while streaming (012 US2: data-tip layer).
  await expect(page.getByTestId("new-session")).toHaveAttribute("data-tip", /discarded/);

  // 007 US3-3: the in-app dialog carries the streaming-specific warning.
  await page.getByTestId("new-session").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("confirm-title")).toContainText(/while pi is answering/i);
  await expect(page.getByTestId("confirm-message")).toContainText(/discarded/i);

  // Esc cancels: the conversation is untouched.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("item-user").first()).toBeVisible();
  await expect(page.getByTestId("empty-state")).toHaveCount(0);
});

/** spec 005 FR-004 / plan decision 7 — the queue bar lives between the message
 *  list and the composer: rows stay inside the bar (long previews ellipsize,
 *  never overflow), the bar does not push the document sideways, and it sits
 *  above the composer at every supported width. */
for (const width of [360, 680, 900]) {
  test(`queue bar stays between the message list and the composer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/");
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await page.waitForSelector('[data-testid="abort-btn"]', { timeout: 15_000 });
    await page.getByTestId("send-mode-caret").click();
    await page.getByTestId("send-mode-followUp").click();
    await page
      .getByTestId("composer-input")
      .fill("a queued entry with a reasonably long preview text that must truncate, not overflow");
    await page.getByTestId("send-btn").click();
    const bar = page.getByTestId("queue-bar");
    await expect(bar).toBeVisible();

    const r = await page.evaluate(() => {
      const de = document.documentElement;
      const bar = document.querySelector(".queue-bar")!.getBoundingClientRect();
      const comp = document.querySelector(".composer")!.getBoundingClientRect();
      const list = document.querySelector(".message-list")!.getBoundingClientRect();
      const rows = [...document.querySelectorAll(".queue-row")].map((el) => el.getBoundingClientRect());
      return {
        overflow: de.scrollWidth - de.clientWidth,
        barInsideViewport: bar.left >= 0 && bar.right <= de.clientWidth,
        rowsInsideBar: rows.every((row) => row.left >= bar.left - 1 && row.right <= bar.right + 1),
        barAboveComposer: bar.bottom <= comp.top + 1,
        listEndsAboveBar: list.bottom <= bar.top + 1,
      };
    });

    expect(r.overflow, "document overflows horizontally").toBeLessThanOrEqual(0);
    expect(r.barInsideViewport, "queue bar leaves the viewport").toBe(true);
    expect(r.rowsInsideBar, "queue rows escape the bar").toBe(true);
    expect(r.barAboveComposer, "queue bar overlaps the composer").toBe(true);
    expect(r.listEndsAboveBar, "queue bar overlaps the message list").toBe(true);
  });
}

/** The queue is a third column of the same panel, so it shares the content
 *  column with the messages and the input box. A queue that runs to the
 *  panel edges reads as a separate panel, and its row buttons land far
 *  outside the column the rest of the UI uses (real machine: 1180px rows
 *  against a 780px input box, overhanging 200px on each side). */
for (const width of [360, 680, 1200]) {
  test(`queue rows share the content column at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/");
    await page.getByTestId("composer-input").fill("start");
    await page.getByTestId("send-btn").click();
    await page.waitForSelector('[data-testid="abort-btn"]', { timeout: 15_000 });
    await page.getByTestId("send-mode-caret").click();
    await page.getByTestId("send-mode-followUp").click();
    await page
      .getByTestId("composer-input")
      .fill("a queued entry with a reasonably long preview text that must truncate, not overflow");
    await page.getByTestId("send-btn").click();
    await expect(page.getByTestId("queue-row").first()).toBeVisible();

    const r = await page.evaluate(() => {
      const box = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, width: b.width };
      };
      return {
        row: box(".queue-row"),
        band: box(".queue-col"),
        composer: box(".composer-box"),
        column: box(".message-col"),
        card: box(".tool-card"),
      };
    });

    const row = r.row!;
    const composer = r.composer!;
    // The row starts and ends exactly where the input box does.
    expect(Math.abs(row.left - composer.left), "queue row starts left of the input box").toBeLessThanOrEqual(1);
    expect(Math.abs(row.right - composer.right), "queue row ends right of the input box").toBeLessThanOrEqual(1);
    expect(row.width, "queue row is wider than the input box").toBeLessThanOrEqual(composer.width + 1);
    // …and where the message column does.
    if (r.column) {
      expect(Math.abs(row.left - r.column.left), "queue row starts left of the message column").toBeLessThanOrEqual(1);
      expect(Math.abs(row.right - r.column.right), "queue row ends right of the message column").toBeLessThanOrEqual(1);
    }
    // The band around the rows stops at the column too — a band that ran to
    // the panel edges left two empty wings of grey beside the rows.
    if (r.band) {
      expect(Math.abs(r.band.left - composer.left), "queue band starts left of the input box").toBeLessThanOrEqual(1);
      expect(Math.abs(r.band.right - composer.right), "queue band ends right of the input box").toBeLessThanOrEqual(1);
    }
    // The cards in the transcript are UI, not prose: they fill the column.
    if (r.card) {
      expect(Math.abs(r.card.left - composer.left), "tool card starts left of the input box").toBeLessThanOrEqual(1);
      expect(Math.abs(r.card.right - composer.right), "tool card ends right of the input box").toBeLessThanOrEqual(1);
    }
  });
}

/** The approval prompt is a member of the content column like everything
 *  else — it used to span the whole panel and stuck out on both sides. */
test("the approval prompt shares the content column at 1200px", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto("/?approval=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("run the check");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("approval-card")).toBeVisible();

  const r = await page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, width: b.width };
    };
    return { card: box(".approval-card"), composer: box(".composer-box"), column: box(".message-col") };
  });

  const card = r.card!;
  const composer = r.composer!;
  expect(Math.abs(card.left - composer.left), "approval prompt starts left of the input box").toBeLessThanOrEqual(1);
  expect(Math.abs(card.right - composer.right), "approval prompt ends right of the input box").toBeLessThanOrEqual(1);
  expect(card.width, "approval prompt is wider than the input box").toBeLessThanOrEqual(composer.width + 1);
  if (r.column) {
    expect(Math.abs(card.left - r.column.left), "approval prompt starts left of the message column").toBeLessThanOrEqual(1);
    expect(Math.abs(card.right - r.column.right), "approval prompt ends right of the message column").toBeLessThanOrEqual(1);
  }
});

/** One axis for the whole transcript. The tool card, the prose and the code
 *  block are all members of the content column, so they start and end where
 *  the column does. A card that reaches the column's right edge while the
 *  code block below it stops 60px short reads as "the command row is about
 *  to hit the limit" (real machine: 780px card against a 718px markdown —
 *  the markdown had been capped at 92% for no reason). */
test("every block in the message column shares the column's width", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/");
  await page.evaluate(() => {
    const s = (
      window as unknown as { __piStore: { setState: (p: Record<string, unknown>) => void } }
    ).__piStore;
    s.setState({
      items: [
        {
          id: 1,
          role: "assistant",
          done: true,
          blocks: [
            {
              kind: "toolcall",
              id: "tc-1",
              toolName: "bash",
              argsJson: JSON.stringify({ command: "echo hello" }),
              done: true,
              result: { output: "hello", isError: false, durationMs: 3 },
            },
            { kind: "text", text: "正文一句。\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n", done: true },
          ],
        },
      ],
    });
  });
  await expect(page.getByTestId("tool-card").first()).toBeVisible();
  await expect(page.locator(".markdown .block-shell").first()).toBeVisible();

  const r = await page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, width: b.width };
    };
    const col = document.querySelector(".message-col")!.getBoundingClientRect();
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll(".message-col *"))) {
      const b = el.getBoundingClientRect();
      if (b.right > col.right + 1) {
        offenders.push(el.tagName.toLowerCase() + "." + String(el.className || "").split(" ").filter(Boolean).join("."));
      }
    }
    return {
      col: { left: col.left, right: col.right },
      card: box(".tool-card"),
      body: box(".item-assistant .item-body"),
      markdown: box(".item-assistant .markdown"),
      block: box(".markdown .block-shell"),
      offenders: offenders.slice(0, 5),
    };
  });

  for (const [name, b] of [
    ["tool card", r.card],
    ["item body", r.body],
    ["markdown", r.markdown],
    ["code block", r.block],
  ] as const) {
    expect(b, name + " is missing").not.toBeNull();
    expect(Math.abs(b!.left - r.col.left), name + " does not start at the column's left edge").toBeLessThanOrEqual(1);
    expect(Math.abs(b!.right - r.col.right), name + " does not end at the column's right edge").toBeLessThanOrEqual(1);
  }
  expect(r.offenders, "a block sticks out past the content column").toHaveLength(0);
});

/** A markdown image has no intrinsic width limit. Without one it grows past
 *  the column and the list's horizontal overflow clips it away (real machine:
 *  a 1400px image overhung the column by 620px and the panel by 324px, and
 *  `.message-list` has `overflow-x: hidden` — the picture was simply gone). */
test("a wide image in a message stays inside the content column", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/");
  await page.evaluate(() => {
    const s = (
      window as unknown as { __piStore: { setState: (p: Record<string, unknown>) => void } }
    ).__piStore;
    s.setState({
      items: [
        { id: 1, role: "assistant", done: true, blocks: [{ kind: "text", text: "看图：", done: true }] },
      ],
    });
  });
  await expect(page.locator(".item-assistant .markdown").first()).toBeVisible();

  const r = await page.evaluate(async () => {
    const md = document.querySelector(".item-assistant .markdown")!;
    const img = document.createElement("img");
    img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    img.style.width = "1400px";
    img.style.height = "40px";
    md.appendChild(img);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const col = document.querySelector(".message-col")!.getBoundingClientRect();
    const b = img.getBoundingClientRect();
    const de = document.documentElement;
    return { overRight: b.right - col.right, width: b.width, docOverflow: de.scrollWidth - de.clientWidth };
  });

  expect(r.overRight, "the image sticks out past the content column").toBeLessThanOrEqual(1);
  expect(r.docOverflow, "the document overflows horizontally").toBeLessThanOrEqual(0);
});
