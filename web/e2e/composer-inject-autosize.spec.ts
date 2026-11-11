import { expect, test, type Page } from "@playwright/test";

/**
 * 025 — whatever lands in the composer (IDE action, quote, drop, restore)
 * must grow to its capped height AND reveal its tail, even when the injection
 * happened before the layout existed. All numbers here are read from the live
 * textarea — not existence checks.
 */

/** 30 lines: far past the 320px cap, so the box must scroll inside. */
const LONG_TEXT = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of the injected block`).join("\n");

type TaRead = {
  height: string;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  valueLength: number;
  caret: number;
  appHeight: number;
};

async function readTa(page: Page): Promise<TaRead> {
  return page.evaluate(() => {
    const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    const app = document.querySelector(".app") as HTMLElement;
    return {
      height: ta.style.height,
      scrollTop: ta.scrollTop,
      clientHeight: ta.clientHeight,
      scrollHeight: ta.scrollHeight,
      valueLength: ta.value.length,
      caret: ta.selectionStart,
      appHeight: app.clientHeight,
    };
  });
}

async function inject(page: Page, text: string) {
  await page.evaluate((t) => window.__piMockIde?.({ kind: "prompt", text: t }), text);
}

test("US1: a 30-line injection grows to the cap, shows the tail, caret at the end", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeVisible();

  await inject(page, LONG_TEXT);
  // The injection lands through store → effect → rAF; wait for the height to
  // actually be applied before reading (30 lines are way past any single line).
  await page.waitForFunction(
    () => {
      const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
      return ta && parseFloat(ta.style.height) > 100;
    },
    undefined,
    { timeout: 3_000 },
  );
  const ta = await readTa(page);
  const cap = Math.min(320, Math.floor(ta.appHeight * 0.45));

  expect(ta.height).toBe(`${cap}px`);
  expect(ta.scrollHeight - ta.scrollTop - ta.clientHeight).toBeLessThanOrEqual(1);
  expect(ta.caret).toBe(ta.valueLength);
});

test("US2: injecting while hidden still ends up sized and revealed once visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeVisible();

  // The tool window "hidden" case: no layout to measure.
  await page.evaluate(() => {
    (document.querySelector(".app") as HTMLElement).style.display = "none";
  });
  await inject(page, Array.from({ length: 20 }, (_, i) => `hidden line ${i + 1}`).join("\n"));
  // While hidden nothing can be measured; the box is floor-clamped at best.
  const hidden = await readTa(page);
  expect(hidden.height === "34px" || hidden.appHeight === 0).toBe(true);

  // Visible again: the app ResizeObserver fires 0 → real and re-measures once.
  await page.evaluate(() => {
    (document.querySelector(".app") as HTMLElement).style.display = "";
  });
  await page.waitForFunction(() => {
    const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    return ta && parseFloat(ta.style.height) > 34 && ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 1;
  }, undefined, { timeout: 3_000 });

  const ta = await readTa(page);
  expect(parseFloat(ta.height)).toBeGreaterThan(34);
  expect(ta.scrollHeight - ta.scrollTop - ta.clientHeight).toBeLessThanOrEqual(1);
});

test("US3: a short injection is exactly content-height; a draft survives a quote", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeVisible();

  const threeLines = "alpha\nbeta\ngamma";
  await inject(page, threeLines);
  await page.waitForFunction(
    () => {
      const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
      return ta && parseFloat(ta.style.height) > 34 && ta.value.includes("gamma");
    },
    undefined,
    { timeout: 3_000 },
  );
  const ta = await readTa(page);
  // height === clamp(scrollHeight, appHeight): the exact policy, recomputed
  // from the live DOM — no spare blank space below the third line.
  const cap = Math.max(Math.min(320, Math.floor(ta.appHeight * 0.45)), 34);
  const expected = Math.min(Math.max(ta.scrollHeight, 34), cap);
  expect(parseFloat(ta.height)).toBe(expected);
  // The injected text is intact and the caret sits after it.
  expect(ta.caret).toBe(ta.valueLength);

  // Draft preservation (010 FR-006): send the injected text to get a message
  // to quote, type a fresh draft, then quote — the draft stays verbatim at
  // the head and the result scrolls to the bottom.
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("item-assistant").first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("composer-input").fill("my own draft");

  // The toolbar is hover-only (visibility:hidden until then) — hover the item,
  // then the quote button becomes clickable.
  const assistant = page.getByTestId("item-assistant").first();
  await assistant.hover();
  const quoteBtn = assistant.getByTestId("act-quote");
  await expect(quoteBtn).toBeVisible({ timeout: 5_000 });
  await quoteBtn.click();

  await page.waitForFunction(
    () => {
      const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
      // The quoted reply must actually have landed (length grows past the
      // draft) AND the box reveals its tail — a bare draft satisfies neither
      // meaningfully.
      return (
        ta &&
        ta.value.length > "my own draft".length &&
        ta.value.startsWith("my own draft") &&
        ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 1
      );
    },
    undefined,
    { timeout: 5_000 },
  );
  const after = await readTa(page);
  expect(after.valueLength).toBeGreaterThan("my own draft".length);
});

test("US4: a manual scroll-up is never dragged back down by unrelated updates", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeVisible();

  await inject(page, LONG_TEXT);
  await page.waitForFunction(() => {
    const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    return ta && ta.scrollTop > 0;
  });

  // The user scrolls up two lines.
  await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    ta.scrollTop = Math.max(0, ta.scrollTop - 40);
  });
  const before = await readTa(page);
  expect(before.scrollTop).toBeGreaterThan(0);

  // Unrelated layout churn: a viewport GROWTH (cap stays 320 — the absolute
  // ceiling — so the box height does not move and scrollTop cannot be clamped
  // by geometry). The app ResizeObserver runs its plain re-measure — no
  // reveal — and must not drag the view back to the tail.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  const after = await readTa(page);
  expect(after.scrollTop).toBe(before.scrollTop);
  expect(after.height).toBe(before.height);
});
