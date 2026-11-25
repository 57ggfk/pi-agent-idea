import { expect, test, type Page } from "@playwright/test";

/**
 * 050 — CSV / TSV 代码块渲染成表格。
 *
 * 模型输出分隔符文本时，用户只能逐行读原始的逗号 / 制表符。050 让
 * ```csv / ```tsv 围栏默认渲染成表格：第一行进表头，其余行进数据行，
 * 单元格内容与原文逐字一致，源码隐藏，并且可以切回源码（复用 049 的
 * 「渲染 ⇄ 源码」链路）。
 *
 * 覆盖：
 *   US1 CSV 渲染成表格      US2 TSV / 标签错配
 *   US3 可切回源码          US4 大块数据截断并标注（中日双语）
 *   US5 宽表横向滚动        US6 解析失败降级
 *   US7 零回归（管道表不受影响）
 */

/** 驱动 mock 出一条带指定 markdown 场景的回复。 */
async function sendMock(page: Page, md: string, locale?: string) {
  const q = new URLSearchParams({ md });
  if (locale) q.set("locale", locale);
  await page.goto(`/?${q.toString()}`);
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show me the data");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  // The 205-row fixture streams one line per 40ms — give it room.
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 45_000 });
}

/** The n-th code block of the reply (`.block-shell` = one fenced block). */
const block = (page: Page, n = 0) => page.locator(".markdown .block-shell").nth(n);

/**
 * Reads a block's display state — independent of whether a table came out.
 */
async function readBlock(page: Page, n = 0) {
  return page.evaluate((idx) => {
    const shell = document.querySelectorAll(".markdown .block-shell")[idx] as HTMLElement | undefined;
    if (!shell) return null;
    const code = shell.querySelector("code") as HTMLElement;
    const pre = shell.querySelector("pre") as HTMLElement;
    const modeBtn = shell.querySelector(".code-source-btn") as HTMLButtonElement | null;
    return {
      lang: shell.querySelector(".block-lang")?.textContent ?? "",
      codeHidden: getComputedStyle(code).display === "none",
      // The table lives OUTSIDE the pre, so the emptied pre must not leave a
      // dead strip under the table (measured: 16px of empty pre).
      preVisible: getComputedStyle(pre).display !== "none",
      hasTable: !!shell.querySelector(".csv-table-wrap table"),
      modePresent: !!modeBtn,
      modeDisabled: modeBtn?.disabled ?? false,
      modePressed: modeBtn?.getAttribute("aria-pressed") ?? null,
    };
  }, n);
}

/**
 * Reads the rendered table of a block — **null** when the block carries no
 * table (not a table at all, or the block is in source mode).
 */
async function readTable(page: Page, n = 0) {
  return page.evaluate((idx) => {
    const shell = document.querySelectorAll(".markdown .block-shell")[idx] as HTMLElement | undefined;
    if (!shell) return null;
    const table = shell.querySelector(".csv-table-wrap table");
    if (!table) return null;
    return {
      head: Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent ?? ""),
      rows: Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""),
      ),
      notes: Array.from(shell.querySelectorAll(".csv-table-note")).map((el) => el.textContent ?? ""),
    };
  }, n);
}

test("a csv block renders as a table: header on top, cells verbatim, source hidden (050 US1)", async ({ page }) => {
  await sendMock(page, "csv");
  const t = await readTable(page, 0);
  expect(t).not.toBeNull();
  expect(t!.head).toEqual(["name", "role", "note"]);
  expect(t!.rows).toEqual([
    // A quoted field holds the delimiter — it is content, not a separator.
    ["Alice", "dev", "likes, commas"],
    // "" is one literal quote.
    ["Bob", "ops", 'says "hi"'],
  ]);
  const b = await readBlock(page, 0);
  expect(b!.lang).toBe("CSV");
  // The source is replaced by the table (FR-001).
  expect(b!.codeHidden).toBe(true);
  // …and the emptied pre must not leave a dead strip under the table.
  expect(b!.preVisible).toBe(false);
});

test("a tsv block renders as a table, and a csv-tagged tsv still parses (050 US2)", async ({ page }) => {
  await sendMock(page, "csv");
  const tsv = await readTable(page, 1);
  expect(tsv).not.toBeNull();
  expect(tsv!.head).toEqual(["name", "age"]);
  expect(tsv!.rows).toEqual([["Alice", "31"], ["Bob", "28"]]);
  expect((await readBlock(page, 1))!.lang).toBe("TSV");

  // The model tagged a TSV body as csv: the default delimiter never shows
  // up, so the other one takes over (FR-004).
  const mislabeled = await readTable(page, 2);
  expect(mislabeled).not.toBeNull();
  expect(mislabeled!.head).toEqual(["name", "role"]);
  expect(mislabeled!.rows).toEqual([["Alice", "dev"]]);
});

test("a quoted field keeps its newline and its delimiter (050 FR-002)", async ({ page }) => {
  await sendMock(page, "csv");
  const t = await readTable(page, 3);
  expect(t).not.toBeNull();
  expect(t!.head).toEqual(["note", "value"]);
  expect(t!.rows).toEqual([["multi\nline", "7"]]);
});

test("the source switch folds the table away and brings it back (050 US3)", async ({ page }) => {
  await sendMock(page, "csv");
  const modeBtn = block(page, 0).locator(".code-source-btn");
  await expect(modeBtn).toHaveAttribute("aria-pressed", "false");

  // Source mode: the table is gone, the raw CSV is back — byte for byte.
  await modeBtn.click();
  await expect.poll(async () => (await readBlock(page, 0))!.hasTable).toBe(false);
  expect((await readBlock(page, 0))!.codeHidden).toBe(false);
  expect((await readBlock(page, 0))!.preVisible).toBe(true);
  const source = await block(page, 0).locator("code").textContent();
  expect(source).toContain("name,role,note");
  expect(source).toContain('Alice,dev,"likes, commas"');
  await expect(modeBtn).toHaveAttribute("aria-pressed", "true");

  // …and back to the table.
  await modeBtn.click();
  await expect.poll(async () => (await readBlock(page, 0))!.hasTable).toBe(true);
  const back = await readTable(page, 0);
  expect(back!.head).toEqual(["name", "role", "note"]);
  expect(back!.rows.length).toBe(2);
  expect((await readBlock(page, 0))!.codeHidden).toBe(true);
  expect((await readBlock(page, 0))!.preVisible).toBe(false);
});

test("a 205-row table renders 200 rows and says so (050 US4)", async ({ page }) => {
  await sendMock(page, "csv-big");
  const t = await readTable(page, 0);
  expect(t).not.toBeNull();
  expect(t!.rows.length).toBe(200);
  expect(t!.notes.length).toBeGreaterThan(0);
  expect(t!.notes.join(" ")).toContain("205");
  expect(t!.notes.join(" ")).toContain("200");
});

test("the truncation note is bilingual (050 US4 / FR-009)", async ({ page }) => {
  await sendMock(page, "csv-big");
  const en = await readTable(page, 0);
  expect(en!.notes.join(" ")).toContain("205 rows in total");
  expect(en!.notes.join(" ")).toContain("showing the first 200");

  await sendMock(page, "csv-big", "zh");
  const zh = await readTable(page, 0);
  expect(zh!.notes.join(" ")).toContain("已截断：共 205 行，仅显示前 200 行");
});

test("a wide table scrolls horizontally instead of being cut off (050 US5)", async ({ page }) => {
  await sendMock(page, "csv-wide");
  const t = await readTable(page, 0);
  expect(t).not.toBeNull();
  expect(t!.head.length).toBe(30);
  expect(t!.rows.length).toBe(2);

  const metrics = await page.evaluate(() => {
    const wrap = document.querySelector(".markdown .csv-table-wrap") as HTMLElement;
    // The table must NOT live inside the pre — the pre is the code's own
    // horizontal scroller, the table brings its own.
    const insidePre = !!document.querySelector(".csv-table-wrap pre");
    wrap.scrollLeft = 120;
    return { scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth, scrolled: wrap.scrollLeft, insidePre };
  });
  expect(metrics.insidePre).toBe(false);
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  expect(metrics.scrolled).toBeGreaterThan(0);
});

test("a 60-column table is cut to 50 columns and says so (050 Q4)", async ({ page }) => {
  await sendMock(page, "csv-wide");
  const t = await readTable(page, 1);
  expect(t).not.toBeNull();
  expect(t!.head.length).toBe(50);
  expect(t!.rows[0].length).toBe(50);
  expect(t!.notes.join(" ")).toContain("60");
  expect(t!.notes.join(" ")).toContain("50");
});

test("a block that is not a table falls back to its source (050 US6)", async ({ page }) => {
  await sendMock(page, "csv");
  // No delimiter at all, and a single record — neither is a table.
  expect(await readTable(page, 4)).toBeNull();
  expect(await readTable(page, 5)).toBeNull();

  const prose = await readBlock(page, 4);
  expect(prose!.codeHidden).toBe(false);
  expect(prose!.modePresent).toBe(true);
  // The switch is never greyed out: a streaming prefix fails to parse all
  // the time, and the user must always be able to ask for the source.
  expect(prose!.modeDisabled).toBe(false);

  // Asking for the render on a block that cannot render flashes ✗ and keeps
  // the source — no silent no-op.
  const modeBtn = block(page, 4).locator(".code-source-btn");
  await modeBtn.click();
  await expect(modeBtn).toHaveAttribute("aria-pressed", "true");
  await modeBtn.click();
  await expect(modeBtn).toHaveText("✗", { timeout: 3000 });
  expect((await readBlock(page, 4))!.codeHidden).toBe(false);
  expect((await readBlock(page, 4))!.hasTable).toBe(false);
});

test("the csv table reuses the existing table styling (050 T505)", async ({ page }) => {
  await sendMock(page, "csv");
  const styles = await page.evaluate(() => {
    const table = document.querySelector(".csv-table-wrap table") as HTMLElement;
    const th = document.querySelector(".csv-table-wrap thead th") as HTMLElement;
    const td = document.querySelector(".csv-table-wrap tbody td") as HTMLElement;
    return {
      collapse: getComputedStyle(table).borderCollapse,
      thBg: getComputedStyle(th).backgroundColor,
      tdBg: getComputedStyle(td).backgroundColor,
      thBorderBottom: getComputedStyle(th).borderBottomWidth,
    };
  });
  expect(styles.collapse).toBe("collapse");
  // The header keeps its own quiet grey (--table-head-bg), the cells do not.
  expect(styles.thBg).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.thBg).not.toBe(styles.tdBg);
  expect(styles.thBorderBottom).toBe("1px");
});

test("the Markdown pipe table is untouched (050 US7)", async ({ page }) => {
  await sendMock(page, "table");
  const pipe = page.locator(".markdown table");
  await expect(pipe).toHaveCount(1);
  await expect(pipe.locator("thead th")).toHaveCount(2);
  // A pipe table is not a code block: no csv container, no mode switch.
  await expect(page.locator(".markdown .csv-table-wrap")).toHaveCount(0);
  await expect(page.locator(".markdown .code-source-btn")).toHaveCount(0);
});
