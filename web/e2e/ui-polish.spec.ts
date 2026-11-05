import { expect, test, type Page } from "@playwright/test";

/**
 * Geometry assertions for spec 010 (界面细节打磨).
 *
 * Three user stories, all judged by numbers instead of by eye — `toBeVisible()`
 * passes on a bubble that is twice as tall as it needs to be, which is exactly
 * how the original defects shipped.
 *
 * Baselines come from `specs/010-ui-polish/plan.md` §现状（T001, 680×760,
 * mock bridge) and are pinned here so a future style change cannot quietly
 * undo the compaction: a one-line 「好的」 bubble measured 72.28px there.
 */

/** T001 baseline: `.item-user` height for a single-line message. */
const BASELINE_ONE_LINE = 72.28;

/** Hard ceiling from FR-001. */
const MAX_ONE_LINE_BUBBLE = 32;

const ONE_LINE = "好的";

const rect = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
  }, sel);

/** Sends one message and waits for the mock run to settle. */
async function sendAndWait(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

/** Height of the textarea's single (empty) line, measured before any input. */
async function singleLineHeight(page: Page) {
  return page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    return Math.round(ta.getBoundingClientRect().height);
  });
}

// ---------------------------------------------------------------- US2 空态居中

/** T004 / SC-002 — the empty state sits on the visible centre of the message
 *  area at three window heights. Before the fix it hugged the top: the group
 *  was −25 / −175 / −325px off. Measured on `.empty-state` (icon + title +
 *  model line) rather than on `.empty-logo`: the group is what "centered"
 *  means, and an icon-only anchor would leave the two text lines hanging
 *  visibly low. See run-report §5 for the deviation from the task wording. */
for (const [height, tolerance] of [
  [300, 4],
  [600, 2],
  [900, 2],
] as const) {
  test(`empty state is centered on the visible message area at ${height}px tall`, async ({ page }) => {
    await page.setViewportSize({ width: 680, height });
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();

    const r = await page.evaluate(() => {
      const list = document.querySelector(".message-list")!.getBoundingClientRect();
      const empty = document.querySelector(".empty-state")!.getBoundingClientRect();
      const logo = document.querySelector(".empty-logo")!.getBoundingClientRect();
      return {
        dv: empty.top + empty.height / 2 - (list.top + list.height / 2),
        dh: logo.left + logo.width / 2 - (list.left + list.width / 2),
        emptyHeight: empty.height,
        logoOffset: logo.top + logo.height / 2 - (empty.top + empty.height / 2),
        insideList: empty.top >= list.top && empty.bottom <= list.bottom && logo.top >= list.top,
      };
    });

    // 12px of asymmetry in the old padding moved the centre by 6px; the old
    // `margin: auto` with no free space moved it by hundreds.
    expect(Math.abs(r.dv), `empty state is ${r.dv.toFixed(1)}px off centre`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(r.dh), "empty state is off centre horizontally").toBeLessThanOrEqual(0.5);
    expect(r.insideList, "empty state is clipped vertically").toBe(true);
    // The icon is the first of three stacked lines, so it is expected to sit
    // above the group's centre — but only by about half a line, never by the
    // hundreds of px the old layout produced.
    expect(Math.abs(r.logoOffset), "the icon is not the top line of the block").toBeLessThanOrEqual(
      r.emptyHeight / 2,
    );
  });
}

/** T005 / FR-005 — with messages present the column must still start at the top
 *  (`min-height: 100%` must not vertically centre the conversation). */
test("messages still start at the top once the conversation is not empty", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 760 });
  await page.goto("/");
  await sendAndWait(page, "hello");

  const r = await page.evaluate(() => {
    const de = document.documentElement;
    const list = document.querySelector(".message-list")!.getBoundingClientRect();
    const items = document.querySelectorAll(".item");
    const first = items[0]!.getBoundingClientRect();
    return {
      count: items.length,
      gapAboveFirst: first.top - list.top,
      overflowX: de.scrollWidth - de.clientWidth,
    };
  });

  expect(r.count).toBeGreaterThanOrEqual(2);
  // 16px padding + a couple of px of line-box slack. The old failure mode was
  // "every message pushed to the middle", i.e. hundreds of px.
  expect(r.gapAboveFirst, "the message column was vertically centered").toBeLessThanOrEqual(24);
  expect(r.overflowX, "document overflows horizontally").toBeLessThanOrEqual(0);
});

// ---------------------------------------------------------------- US1 气泡紧凑

/** T007 / FR-001 / SC-001 — a one-line message is ≤32px and at most 85% of the
 *  pre-fix height, with the text neither clipped nor shrunk. */
test("a one-line message bubble is compact and its text is not clipped", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 760 });
  await page.goto("/");
  await sendAndWait(page, ONE_LINE);

  const r = await page.evaluate((label) => {
    const items = document.querySelectorAll<HTMLElement>('[data-testid="item-user"]');
    const item = items[items.length - 1]!;
    const body = item.querySelector<HTMLElement>(".item-body")!;
    const cs = getComputedStyle(body);
    const col = document.querySelector(".message-col")!.getBoundingClientRect();
    const text = body.textContent ?? "";
    return {
      itemH: item.getBoundingClientRect().height,
      bodyH: body.getBoundingClientRect().height,
      clipped: body.scrollHeight > body.clientHeight + 1 || body.scrollWidth > body.clientWidth + 1,
      lineHeightRatio: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize),
      fontSize: cs.fontSize,
      textExact: text === label,
      right: item.getBoundingClientRect().right,
      colRight: col.right,
    };
  }, ONE_LINE);

  expect(r.bodyH, `bubble is ${r.bodyH.toFixed(1)}px tall`).toBeLessThanOrEqual(MAX_ONE_LINE_BUBBLE);
  expect(r.bodyH / BASELINE_ONE_LINE, "not meaningfully tighter than the 72.28px baseline").toBeLessThanOrEqual(0.85);
  expect(r.clipped, "the text is clipped").toBe(false);
  expect(r.textExact, "the bubble text changed").toBe(true);
  // FR-002: tightened through spacing only — the font size is untouched.
  expect(r.fontSize).toBe("13px");
  expect(r.lineHeightRatio, "line spacing got cramped").toBeGreaterThanOrEqual(1.4);
  expect(r.right, "bubble escapes the message column").toBeLessThanOrEqual(r.colRight + 1);
});

/** T008 / FR-003 — long, multi-line and code-heavy content survives the
 *  compaction without clipping or sideways overflow. */
test("multi-line, code and image messages stay inside the column", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 760 });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.goto("/");

  // (1) five lines of prose
  await sendAndWait(page, ["第一行", "第二行", "第三行", "第四行", "第五行"].join("\n"));

  // (2) a fenced code block long enough to scroll on its own
  await sendAndWait(
    page,
    ["看这段：", "```js", "const wide = 'x'.repeat(200); // " + "y".repeat(80), "```"].join("\n"),
  );

  // (3) an image attachment
  await page.setInputFiles('input[type="file"]', { name: "tiny.png", mimeType: "image/png", buffer: png });
  await expect(page.getByTestId("image-chips")).toContainText("tiny.png");
  await sendAndWait(page, "图片说明");

  const r = await page.evaluate(() => {
    const de = document.documentElement;
    const colEl = document.querySelector(".message-col")!;
    const col = colEl.getBoundingClientRect();
    const bubbles = [...document.querySelectorAll<HTMLElement>('[data-testid="item-user"]')];
    return {
      overflowX: de.scrollWidth - de.clientWidth,
      codeOverflowX: colEl.scrollWidth - colEl.clientWidth,
      col: { left: col.left, right: col.right },
      bubbles: bubbles.map((b) => {
        const body = b.querySelector<HTMLElement>(".item-body")!;
        const rect = b.getBoundingClientRect();
        return {
          clipped: body.scrollHeight > body.clientHeight + 1,
          left: rect.left,
          right: rect.right,
          // FR-003: `.item-user` max-width is 82% of the column.
          share: rect.width / col.width,
          lines: Math.round(body.getBoundingClientRect().height / parseFloat(getComputedStyle(body).lineHeight)),
        };
      }),
      codeOverflow: [...document.querySelectorAll<HTMLElement>(".item-user pre")].map((pre) => ({
        overflow: pre.scrollWidth - pre.clientWidth,
        overflowX: getComputedStyle(pre).overflowX,
      })),
    };
  });

  expect(r.bubbles.length).toBe(3);
  for (const b of r.bubbles) {
    expect(b.clipped, "a bubble's content is clipped").toBe(false);
    expect(b.left).toBeGreaterThanOrEqual(r.col.left - 1);
    expect(b.right).toBeLessThanOrEqual(r.col.right + 1);
    expect(b.share, "bubble wider than its 82% share").toBeLessThanOrEqual(0.83);
  }
  // A five-line message renders as five line boxes, not one squeezed block.
  expect(r.bubbles[0]!.lines).toBeGreaterThanOrEqual(5);
  expect(r.overflowX, "document overflows horizontally").toBeLessThanOrEqual(0);
  expect(r.codeOverflowX, "the message column scrolls sideways").toBeLessThanOrEqual(0);
  // FR-003 words this as `scrollWidth === clientWidth`, but a fenced block is
  // allowed to scroll on its own by design (see `layout.spec.ts`, and it wraps
  // below 480px): a 200-character line inside a 82%-wide bubble has no honest
  // alternative. What must never happen is the text being *unreachable* — so an
  // overflowing block has to be scrollable, and the bubble stays put.
  for (const pre of r.codeOverflow) {
    if (pre.overflow > 0) expect(["auto", "scroll"]).toContain(pre.overflowX);
  }
});

/** T009 / SC-001 — the same conversation now occupies less height.
 *
 *  Measured as a real before/after on one live page: after 20 rounds we record
 *  the column height, then re-inject the pre-010 geometry (values from the T001
 *  baseline in plan.md: `.item-user` 8/12 padding, 1.55 line height, 20px gap)
 *  and record it again. The injected sheet cannot restore the newline strip
 *  that moved into JS, so this *understates* the real gain.
 *
 *  Note on the wording of SC-001 ("visible items +15%"): with the mock's
 *  543px of assistant output per round, one round is already a full screen —
 *  counting items measures the mock's prose length, not the compaction. The
 *  user-message share is asserted instead (FR-001 / plan.md), and the whole
 *  column still has to shrink. See run-report §5. */
test("20 rounds occupy less height than the pre-010 geometry", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 680, height: 760 });
  await page.goto("/");
  for (let i = 1; i <= 20; i++) await sendAndWait(page, `第 ${i} 条`);

  const measure = () =>
    page.evaluate(() => {
      const col = document.querySelector(".message-col")!;
      const items = [...document.querySelectorAll<HTMLElement>(".item")];
      const userH = items
        .filter((el) => el.classList.contains("item-user"))
        .reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
      return {
        column: col.scrollHeight,
        userH,
        userCount: items.filter((el) => el.classList.contains("item-user")).length,
        count: items.length,
        gap: parseFloat(getComputedStyle(col).rowGap || "0"),
      };
    });

  const now = await measure();
  // Pre-010 geometry: the duplicated `.item-user` padding, the 8/12 body
  // padding, `.markdown`'s 1.55 line height and the 20px column gap.
  await page.addStyleTag({
    content: `
      .item-user { padding: 8px 12px !important; }
      .item-user .item-body { padding: 8px 12px !important; line-height: 1.55 !important; }
      .item-user .item-body .markdown { line-height: 1.55 !important; }
      .message-col { gap: 20px !important; }
    `,
  });
  const legacy = await measure();

  expect(now.count).toBeGreaterThanOrEqual(20);
  expect(now.gap, "column spacing did not tighten").toBe(14);
  expect(legacy.gap).toBe(20);
  // Same 20 rounds, measurably less scrolling.
  expect(now.column, `column ${now.column}px vs legacy ${legacy.column}px`).toBeLessThan(legacy.column);
  // The user-message share is where US1 pays off: ≤0.85 of the old height.
  expect(now.userH / legacy.userH, "user bubbles are not meaningfully tighter").toBeLessThanOrEqual(0.85);
  expect(now.userCount).toBe(20);
});

// ---------------------------------------------------------------- US3 输入框自适应

/** T012 / FR-008 / FR-009 — sending collapses the box to one line, and the
 *  height is frozen while an IME composition is in flight. */
test("sending collapses the composer, and composition does not resize it", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 760 });
  await page.goto("/");
  const single = await singleLineHeight(page);

  const draft = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
  await page.getByTestId("composer-input").fill(draft);
  const grown = (await rect(page, '[data-testid="composer-input"]'))!;
  expect(grown.height, "the composer did not grow with its content").toBeGreaterThan(single + 20);

  await sendAndWait(page, draft);
  const after = (await rect(page, '[data-testid="composer-input"]'))!;
  expect(after.height, "the composer did not collapse back after sending").toBeLessThanOrEqual(single + 2);

  // IME: text arriving mid-composition must not bounce the box.
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  const composingText = Array.from({ length: 6 }, (_, i) => `composition ${i + 1}`).join("\n");
  await page.evaluate((text) => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    // Bypass React's value tracker so the synthetic onChange fires.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, composingText);
  const during = (await rect(page, '[data-testid="composer-input"]'))!;
  expect(during.height, "the composer resized during an IME composition").toBeLessThanOrEqual(single + 2);

  // Committing the composition is allowed to resize once.
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    ta.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
  });
  const committed = (await rect(page, '[data-testid="composer-input"]'))!;
  expect(committed.height, "the composer did not grow when the composition committed").toBeGreaterThan(single + 20);
});

/** T013 / FR-007 — the cap is `min(320, 45% × app height)`, above it the box
 *  scrolls internally and the message list keeps ≥200px. */
for (const height of [400, 760, 1200]) {
  test(`composer cap follows the window height at ${height}px tall`, async ({ page }) => {
    await page.setViewportSize({ width: 680, height });
    await page.goto("/");

    const huge = Array.from({ length: 200 }, (_, i) => `row ${i + 1}`).join("\n");
    await page.getByTestId("composer-input").fill(huge);

    const r = await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
      const app = document.querySelector(".app") as HTMLElement;
      const list = document.querySelector(".message-list")!.getBoundingClientRect();
      const cs = getComputedStyle(ta);
      return {
        h: ta.getBoundingClientRect().height,
        scroll: ta.scrollHeight,
        client: ta.clientHeight,
        cap: Math.floor(Math.min(320, app.clientHeight * 0.45)),
        cssVar: cs.maxHeight,
        cssCap: parseFloat(getComputedStyle(app).getPropertyValue("--composer-max-h")),
        appH: app.clientHeight,
        listH: list.height,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

    // The cap is derived from the app height, so it differs per window size —
    // that is the whole point of FR-007 (a fixed 160px was too short when wide).
    expect(Math.round(r.h), `composer is ${Math.round(r.h)}px, cap ${r.cap}px`).toBe(r.cap);
    expect(r.scroll, "200 rows must overflow the box, not the window").toBeGreaterThan(r.client);
    expect(r.cssCap, "CSS and JS disagree about the cap").toBe(r.cap);
    expect(r.cssVar).toBe(`${r.cap}px`);
    // FR-007 also asks for ≥200px of message area. Above ~560px tall both
    // clauses hold at once; at 400px the 45% cap (180px) plus the composer
    // chrome (~90px: buttons row, status bar) leave 92px, so the two clauses
    // are arithmetically incompatible — the list must not be swallowed, and
    // the conflict is recorded in run-report §5.
    if (height >= 600) expect(r.listH, "the message list was squeezed").toBeGreaterThanOrEqual(200);
    else expect(r.listH, "the message list was swallowed").toBeGreaterThanOrEqual(80);
    expect(r.overflowX, "document overflows horizontally").toBeLessThanOrEqual(0);
  });
}

/** T014 — fonts finishing late changes the metrics; the height must be
 *  recomputed rather than left stale. */
test("the composer height is stable across a font load", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 760 });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const text = Array.from({ length: 12 }, (_, i) => `font metric ${i + 1}`).join("\n");
  const measure = async () => {
    await page.getByTestId("composer-input").fill("");
    await page.getByTestId("composer-input").fill(text);
    return (await rect(page, '[data-testid="composer-input"]'))!.height;
  };

  const first = await measure();
  const second = await measure();
  expect(Math.abs(first - second), `height drifted from ${first} to ${second}`).toBeLessThanOrEqual(1);
});
