import { expect, test } from "@playwright/test";

/**
 * Message-table borders (018 US4). The markdown renderer had zero table
 * styling, so tables inside a bubble used the browser default — borderless.
 * Cells now carry a weak theme border (var(--border)) and the header divider
 * is one step stronger (var(--border-strong)).
 */

test("markdown tables in messages show weak borders that follow the theme", async ({ page }) => {
  await page.goto("/?md=table");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show me a table");
  await page.getByTestId("send-btn").click();
  const table = page.locator(".markdown table");
  await expect(table).toHaveCount(1, { timeout: 30_000 });

  const styles = await page.evaluate(() => {
    const td = document.querySelector(".markdown td")!;
    const th = document.querySelector(".markdown th")!;
    const d = getComputedStyle(td);
    const h = getComputedStyle(th);
    return {
      collapse: getComputedStyle(document.querySelector(".markdown table")!).borderCollapse,
      tdWidth: d.borderTopWidth,
      tdStyle: d.borderTopStyle,
      tdColor: d.borderTopColor,
      thBottomWidth: h.borderBottomWidth,
      thBottomColor: h.borderBottomColor,
    };
  });
  expect(styles.collapse).toBe("collapse");
  expect(styles.tdWidth).toBe("1px");
  expect(styles.tdStyle).toBe("solid");
  // a real color, not "none"/transparent
  expect(styles.tdColor).not.toContain("0, 0, 0, 0");
  expect(styles.thBottomWidth).toBe("1px");
});

/** The header row needs to read as a header. A table in a bubble used to
 *  have a white header on white cells — the only difference was a stronger
 *  divider line, which is easy to miss. The header now sits on its own
 *  quiet grey (var(--table-head-bg)), a shade above the page background in
 *  both themes: light grey on white, one step above the panel in the dark
 *  one. The test guards two things: the header is visibly different from the
 *  body, and it is still quiet (a grey that shouts is worse than none). */
test("the table header row has a quiet grey of its own in both themes", async ({ page }) => {
  await page.goto("/?md=table");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show me a table");
  await page.getByTestId("send-btn").click();
  await expect(page.locator(".markdown table")).toHaveCount(1, { timeout: 30_000 });

  const read = () =>
    page.evaluate(() => {
      const th = document.querySelector(".markdown th")!;
      const root = getComputedStyle(document.documentElement);
      return {
        theme: document.documentElement.dataset.theme,
        thBg: getComputedStyle(th).backgroundColor,
        pageBg: root.getPropertyValue("--bg").trim(),
      };
    });

  const light = await read();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  const dark = await read();

  // The page background comes from the theme token (a hex), the header
  // background from getComputedStyle (an rgb() string) — both have to land
  // in the same numeric space before they can be compared.
  const rgb = (v: string): number[] => {
    const t = v.trim();
    if (t.startsWith("#")) {
      const h = t.slice(1);
      const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
      return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    }
    return t.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  };
  const delta = (a: string, b: string) => {
    const x = rgb(a);
    const y = rgb(b);
    return Math.max(Math.abs(x[0] - y[0]), Math.abs(x[1] - y[1]), Math.abs(x[2] - y[2]));
  };

  for (const [name, s] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    expect(s.thBg, name + ": the header has no background of its own").not.toBe("rgba(0, 0, 0, 0)");
    expect(
      delta(s.thBg, s.pageBg),
      name + ": the header is not distinguishable from the body",
    ).toBeGreaterThan(4);
    expect(delta(s.thBg, s.pageBg), name + ": the header grey shouts").toBeLessThanOrEqual(40);
  }
  // The two themes are not the same grey painted twice.
  expect(light.thBg, "the header grey does not follow the theme").not.toBe(dark.thBg);
});

