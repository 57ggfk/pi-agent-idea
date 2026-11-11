import { test, expect, type Page } from "@playwright/test";

/**
 * Model picker regression (011 US1/US2/US3, tasks T006–T013; 020 US1–US5).
 * Fixtures come from the mock's `?picker=` / `?models=` knobs:
 * - g12: 3 providers × 12 models, current model inside the "mock" group
 * - ep:  includes one empty-provider entry (fallback group)
 * - long: 205 models, current model at flat index 180 (over the per-group cap)
 * - now (`?models=now`): 2 providers / 359 models, current at #300 of the big
 *   group — the real catalog's shape
 * - many20 (`?models=many20`): 20 providers × 100 models → 50 per group
 * - providers55 (`?models=providers55`): 55 providers × 3 models → 50 headers
 */

async function openPicker(page: Page) {
  await page.getByTestId("model-chip").click();
  await expect(page.getByTestId("model-popover")).toBeVisible();
}

async function groupTitles(page: Page) {
  // CSS uppercases the headers; compare case-insensitively
  const texts = await page.getByTestId("model-group").allInnerTexts();
  return texts.map((s) => s.toLowerCase());
}

/** e2e assertion helper (T011/T012): document-level mousedown/keydown listener
 *  bookkeeping, injected before the app boots. */
async function installListenerCounter(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __docListeners: { added: number; removed: number } };
    w.__docListeners = { added: 0, removed: 0 };
    const origAdd = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    document.addEventListener = function (...args: Parameters<Document["addEventListener"]>) {
      if (args[0] === "mousedown" || args[0] === "keydown") w.__docListeners.added++;
      return origAdd(...args);
    } as Document["addEventListener"];
    document.removeEventListener = function (...args: Parameters<Document["removeEventListener"]>) {
      if (args[0] === "mousedown" || args[0] === "keydown") w.__docListeners.removed++;
      return origRemove(...args);
    } as Document["removeEventListener"];
  });
}

async function listenerCounters(page: Page) {
  return page.evaluate(() => (window as unknown as { __docListeners: { added: number; removed: number } }).__docListeners);
}

test.describe("model picker grouping", () => {
  test("renders one header per provider, current group pinned first (T006)", async ({ page }) => {
    await page.goto("/?picker=g12");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    const groups = page.getByTestId("model-group");
    await expect(groups).toHaveCount(3);

    // current model (mock group) pinned first; remaining groups in pi order
    const names = await groupTitles(page);
    expect(names[0]).toContain("mock");
    expect(names[1]).toContain("alpha");
    expect(names[2]).toContain("beta");

    // per-group counts: mock 5 (incl. current), alpha 4, beta 3
    await expect(groups.nth(0)).toContainText("5");
    await expect(groups.nth(1)).toContainText("4");
    await expect(groups.nth(2)).toContainText("3");

    // flat rendered list covers every entry exactly once
    await expect(page.getByTestId("model-option")).toHaveCount(12);
    // the current model carries the check mark
    await expect(page.locator('[data-model-key="mock/mock-model-pro"] .model-option-check')).toHaveText("✓");
  });

  test("filter keeps only groups with hits and reports the hidden remainder (T007)", async ({ page }) => {
    await page.goto("/?picker=long");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);
    const search = page.getByTestId("model-search");

    // bulk-0 matches bulk-000..bulk-004 rendered plus hidden ones — only the
    // bulk group remains, the mock group (current) has no hit and disappears
    await search.fill("bulk-00");
    await expect(page.getByTestId("model-group")).toHaveCount(1);
    // "bulk-00" matches bulk-000..bulk-009 → 10 total, all within the cap →
    // no remainder line
    await expect(page.getByTestId("model-option")).toHaveCount(10);
    await expect(page.locator(".model-list > .panel-empty")).toHaveCount(0);

    await search.fill("no-such-model-keyword");
    await expect(page.getByTestId("model-empty")).toBeVisible();
    await expect(page.getByTestId("model-option")).toHaveCount(0);
  });

  test("cap truncates each provider at 200 entries and surfaces the remainder (T007)", async ({ page }) => {
    await page.goto("/?picker=long");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    // 020 US1: `long` is mock(1) + bulk(204) → n=2 → 200 per group, so the
    // rendered list is 1 + 200 (was: one global 200 that dropped the mock group)
    await expect(page.getByTestId("model-group")).toHaveCount(2);
    await expect(page.getByTestId("model-option")).toHaveCount(201);
    const bulk = page.getByTestId("model-group").nth(1);
    await expect(bulk).toContainText("200/204");
    await expect(page.getByTestId("model-group-more")).toContainText("4");
  });

  test("each provider keeps its own quota — a 355-model group cannot evict a 4-model one (020 US1)", async ({ page }) => {
    await page.goto("/?models=now");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    const groups = page.getByTestId("model-group");
    await expect(groups).toHaveCount(2);
    // big group truncates at 200/355, small group shows all 4
    await expect(groups.nth(0)).toContainText("200/355");
    await expect(groups.nth(1)).toContainText("4");
    await expect(page.getByTestId("model-option")).toHaveCount(204);
    await expect(page.getByTestId("model-group-more")).toContainText("155");
    await expect(page.locator('[data-model-key="xiami/xiami-3"]')).toBeVisible();
  });

  test("a current model truncated out of its group is still pinned and located (020 US4)", async ({ page }) => {
    await page.goto("/?models=now");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    // current sits at #300 of the 355-entry group → exempted to the group head
    const active = page.locator('[data-model-key="mock/mock-model-pro"]');
    await expect(active).toBeVisible();
    await expect(active).toHaveAttribute("data-active", "true");
    const firstKey = await page.evaluate(() => document.querySelector("[data-model-key]")?.getAttribute("data-model-key"));
    expect(firstKey).toBe("mock/mock-model-pro");
    // it is not rendered twice
    await expect(page.locator('[data-model-key="mock/mock-model-pro"]')).toHaveCount(1);
  });

  test("more than 50 providers → 50 groups plus a total-provider notice (020 US1/US5)", async ({ page }) => {
    await page.goto("/?models=providers55");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    await expect(page.getByTestId("model-group")).toHaveCount(50);
    await expect(page.getByTestId("model-option")).toHaveCount(150); // 50 × 3, cap 20 not reached
    await expect(page.getByTestId("model-providers-more")).toContainText("5");
    // dropped providers contribute to the provider notice only
    await expect(page.getByTestId("model-group-more")).toHaveCount(0);
  });

  test("20 providers × 100 → 50 per group, 1000 rows, no provider notice (020 US1)", async ({ page }) => {
    await page.goto("/?models=many20");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    await expect(page.getByTestId("model-group")).toHaveCount(20);
    await expect(page.getByTestId("model-group").nth(0)).toContainText("50/100");
    await expect(page.getByTestId("model-option")).toHaveCount(1000);
    await expect(page.getByTestId("model-providers-more")).toHaveCount(0);
  });

  test("group headers are left aligned: name at the left, count at the right (020 US2)", async ({ page }) => {
    await page.goto("/?picker=g12");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    const geom = await page.evaluate(() => {
      const title = document.querySelector('[data-testid="model-group"]') as HTMLElement;
      const name = title.querySelector(".model-group-name") as HTMLElement;
      const count = title.querySelector(".model-group-count") as HTMLElement;
      const tr = title.getBoundingClientRect();
      const cs = getComputedStyle(title);
      return {
        nameLeft: name.getBoundingClientRect().left - tr.left,
        countRightGap: tr.right - count.getBoundingClientRect().right,
        paddingLeft: parseFloat(cs.paddingLeft),
        paddingRight: parseFloat(cs.paddingRight),
        overflow: count.getBoundingClientRect().right - tr.right,
      };
    });
    // name starts right after the caret + padding (was pushed to the midline)
    expect(geom.nameLeft).toBeLessThanOrEqual(geom.paddingLeft + 60);
    expect(geom.countRightGap).toBeLessThanOrEqual(geom.paddingRight + 16);
    expect(geom.overflow).toBeLessThanOrEqual(0);
  });

  test("empty provider lands in the fallback group, last (T004/T013)", async ({ page }) => {
    await page.goto("/?picker=ep");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    const names = await groupTitles(page);
    expect(names).toHaveLength(3);
    expect(names[2]).toContain("other providers");
    // fallback entries show no provider column
    const orphan = page.locator('[data-model-key="/orphan-1"]');
    await expect(orphan).toBeVisible();
    await expect(orphan.locator(".model-option-provider")).toHaveCount(0);
  });
});

test.describe("model picker open-locate", () => {
  test("opening scrolls the current model into view and highlights it (T008)", async ({ page }) => {
    await page.goto("/?picker=long");
    await expect(page.getByTestId("empty-state")).toBeVisible();

    const before = await page.evaluate(() => ({
      list: document.querySelector(".message-list")?.scrollTop ?? 0,
      app: document.querySelector(".app")?.scrollTop ?? 0,
    }));

    await openPicker(page);
    const active = page.locator('[data-model-key="mock/mock-model-pro"]');
    await expect(active).toHaveAttribute("data-active", "true");

    // the current entry sits fully inside the .model-list viewport
    const inView = await page.evaluate(() => {
      const list = document.querySelector(".model-list")!;
      const el = list.querySelector('[data-model-key="mock/mock-model-pro"]')!;
      const lr = list.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      return er.top >= lr.top && er.bottom <= lr.bottom;
    });
    expect(inView).toBe(true);

    // opening the popover must not scroll anything behind it
    const after = await page.evaluate(() => ({
      list: document.querySelector(".message-list")?.scrollTop ?? 0,
      app: document.querySelector(".app")?.scrollTop ?? 0,
    }));
    expect(after).toEqual(before);
  });

  test("current already visible → opening does not scroll; 30-step nav stays sane (T009)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/?picker=g12");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    // current group pinned first → current model visible without scrolling
    const scrollTopBefore = await page.evaluate(() => document.querySelector(".model-list")!.scrollTop);
    expect(scrollTopBefore).toBe(0);

    const search = page.getByTestId("model-search");
    for (let i = 0; i < 30; i++) await search.press("ArrowDown");
    // highlight rests on the last entry; no page-level scroll errors
    const activeIdx = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-model-key]")).findIndex((el) => el.getAttribute("data-active") === "true"),
    );
    expect(activeIdx).toBe(11);
    for (let i = 0; i < 30; i++) await search.press("ArrowUp");
    const backIdx = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-model-key]")).findIndex((el) => el.getAttribute("data-active") === "true"),
    );
    expect(backIdx).toBe(0);
    expect(errors).toEqual([]);
  });

  test("current model filtered out degrades to highlight 0 without errors (T010)", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/?picker=long");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    // hide the current model behind a filter: the list still renders,
    // highlight starts at the first entry, nothing scrolls or throws
    await page.getByTestId("model-search").fill("bulk-2");
    await expect(page.getByTestId("model-empty")).toHaveCount(0);
    const activeIdx = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-model-key]")).findIndex((el) => el.getAttribute("data-active") === "true"),
    );
    expect(activeIdx).toBe(0);
    expect(errors).toEqual([]);
  });
});

test.describe("model picker outside click", () => {
  test("mousedown outside closes; inside stays; chip toggles once (T011)", async ({ page }) => {
    await page.goto("/?picker=g12");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    // inside: the search input keeps the popover open
    await page.getByTestId("model-search").click();
    await expect(page.getByTestId("model-popover")).toBeVisible();

    // outside: composer input. The popover opens upward and covers the input's
    // left part, so click the uncovered right end.
    const box = (await page.getByTestId("composer-input").boundingBox())!;
    await page.getByTestId("composer-input").click({ position: { x: box.width - 10, y: box.height / 2 } });
    await expect(page.getByTestId("model-popover")).toHaveCount(0);

    // reopen, outside: the message list area
    await openPicker(page);
    await page.getByTestId("message-list").click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId("model-popover")).toHaveCount(0);

    // chip toggles from an open state: one click closes, next reopens, third
    // closes again (no dead state, exactly one toggle per click)
    await openPicker(page);
    await page.getByTestId("model-chip").click();
    await expect(page.getByTestId("model-popover")).toHaveCount(0);
    await page.getByTestId("model-chip").click();
    await expect(page.getByTestId("model-popover")).toBeVisible();
    await page.getByTestId("model-chip").click();
    await expect(page.getByTestId("model-popover")).toHaveCount(0);
  });

  test("Esc closes the picker, composer text untouched, listeners balanced (T012)", async ({ page }) => {
    await installListenerCounter(page);
    await page.goto("/?picker=g12");
    await expect(page.getByTestId("empty-state")).toBeVisible();

    await page.getByTestId("composer-input").fill("survives escape");
    const before = await listenerCounters(page);

    await openPicker(page);
    await expect(page.getByTestId("model-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("model-popover")).toHaveCount(0);
    await expect(page.getByTestId("composer-input")).toHaveValue("survives escape");

    // open/close again via chip toggle: document listener bookkeeping balances
    await page.getByTestId("model-chip").click();
    await expect(page.getByTestId("model-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("model-popover")).toHaveCount(0);

    const after = await listenerCounters(page);
    expect(after.added - before.added).toBe(after.removed - before.removed);
  });
});

test.describe("model picker geometry", () => {
  for (const width of [360, 430, 900]) {
    test(`group titles stay inside the popover at ${width}px (T013)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      await page.goto("/?picker=g12");
      await expect(page.getByTestId("empty-state")).toBeVisible();
      await openPicker(page);

      const ok = await page.evaluate(() => {
        const pop = document.querySelector(".model-popover")!.getBoundingClientRect();
        const titles = Array.from(document.querySelectorAll(".model-group-title"));
        return titles.every((t) => {
          const r = t.getBoundingClientRect();
          return r.left >= pop.left && r.right <= pop.right && r.width <= pop.width;
        });
      });
      expect(ok).toBe(true);
      // no horizontal overflow anywhere in the list
      const overflow = await page.evaluate(() => {
        const list = document.querySelector(".model-list")!;
        return list.scrollWidth - list.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});

// -- 018 US5: provider groups collapse ----------------------------------------

test.describe("model picker collapse", () => {
  test("clicking a header folds the group; keyboard skips hidden entries", async ({ page }) => {
    await page.goto("/?picker=g12");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);
    await expect(page.getByTestId("model-option")).toHaveCount(12);

    const alpha = page.getByTestId("model-group").nth(1);
    await expect(alpha).toHaveAttribute("aria-expanded", "true");
    await alpha.click();
    await expect(page.getByTestId("model-option")).toHaveCount(8); // 12 − 4 alpha
    await expect(alpha).toHaveAttribute("aria-expanded", "false");
    // header + count survive the fold
    await expect(alpha).toContainText("4");

    // 30 ArrowDown from the top must rest on the last VISIBLE entry (index 7),
    // not on a hidden one — the index space is the visible sequence.
    const search = page.getByTestId("model-search");
    for (let i = 0; i < 30; i++) await search.press("ArrowDown");
    const activeIdx = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-model-key]")).findIndex(
        (el) => el.getAttribute("data-active") === "true",
      ),
    );
    expect(activeIdx).toBe(7);

    // unfold restores every entry
    await alpha.click();
    await expect(page.getByTestId("model-option")).toHaveCount(12);
  });

  test("search starts fully expanded and stays foldable (020 US3)", async ({ page }) => {
    await page.goto("/?picker=g12");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);
    // fold alpha with no search → persists (018 US5)
    await page.getByTestId("model-group").nth(1).click();
    await expect(page.getByTestId("model-option")).toHaveCount(8);

    // a fresh search ignores the stored fold: everything matched is visible
    await page.getByTestId("model-search").fill("alpha");
    await expect(page.getByTestId("model-option")).toHaveCount(4);

    // …but the result is foldable, which 018 forbade
    await page.getByTestId("model-group").click();
    await expect(page.getByTestId("model-option")).toHaveCount(0);

    // clearing the search restores the stored fold (alpha still folded)
    await page.getByTestId("model-search").fill("");
    await expect(page.getByTestId("model-option")).toHaveCount(8);
    await expect(page.getByTestId("model-group").nth(1)).toHaveAttribute("aria-expanded", "false");

    // and the search-time fold never persisted: next search is expanded again
    await page.getByTestId("model-search").fill("alpha");
    await expect(page.getByTestId("model-option")).toHaveCount(4);
  });

  test("the collapsed set survives a reload via localStorage", async ({ page }) => {
    await page.goto("/?picker=g12");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);
    await page.getByTestId("model-group").nth(1).click();
    await expect(page.getByTestId("model-option")).toHaveCount(8);

    await page.reload();
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);
    await expect(page.getByTestId("model-option")).toHaveCount(8);
    await expect(page.getByTestId("model-group").nth(1)).toHaveAttribute("aria-expanded", "false");
  });

  test("opening auto-expands the current model's group and locates it", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("pi-agent.model-collapsed", JSON.stringify(["mock"]));
    });
    await page.goto("/?picker=g12");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await openPicker(page);

    // mock holds the current model — the fold must not hide the locate target
    const active = page.locator('[data-model-key="mock/mock-model-pro"]');
    await expect(active).toBeVisible();
    await expect(active).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("model-group").nth(0)).toHaveAttribute("aria-expanded", "true");
  });
});
