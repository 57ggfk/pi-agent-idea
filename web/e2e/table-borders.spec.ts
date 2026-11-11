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
