import { expect, test, type Page } from "@playwright/test";

/**
 * Issue #14 — the diagnostics environment card.
 *
 * One item per line with an aligned label column (FR-001), paths that never
 * break in the middle but ellipsize with the full text in the tooltip
 * (FR-002), versions that arrive on their own and never hold the card back
 * (FR-003), and a card that survives a 360px panel (FR-007).
 */

async function openDiagnostics(page: Page, query = "") {
  await page.goto(query ? `/?${query}` : "/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-tab-diagnostics").click();
  await expect(page.getByTestId("manage-env")).toBeVisible();
}

test("the environment card is a vertical list with an aligned label column (FR-001)", async ({ page }) => {
  await openDiagnostics(page);

  const rows = page.getByTestId("manage-env").locator(".diag-env-row");
  // Every item has its own line: running version, disk version, pi path,
  // agent dir, node, npm, plugin.
  await expect(rows).toHaveCount(7);

  // The labels start at the same x — that is what "aligned" means here.
  const lefts = await rows.evaluateAll((els) =>
    els.map((el) => Math.round(el.querySelector(".diag-env-label")!.getBoundingClientRect().left)),
  );
  expect(new Set(lefts).size).toBe(1);

  // One item per line: every row starts below the previous one.
  const tops = await rows.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  for (let i = 1; i < tops.length; i++) {
    expect(tops[i], `row ${i} is not on its own line`).toBeGreaterThan(tops[i - 1]);
  }
});

test("the card shows the running and the installed pi version (FR-003/FR-005)", async ({ page }) => {
  // ?pistate=1 makes the mock report the running process (version 1.4.0-mock).
  await openDiagnostics(page, "pistate=1");

  await expect(page.getByTestId("pi-running-version")).toHaveText("1.4.0-mock", { timeout: 15_000 });
  await expect(page.getByTestId("pi-version")).toHaveText("1.4.0-mock");
  // Both rows are there — the card never shows only one of them.
  await expect(page.getByTestId("env-running-version")).toBeVisible();
  await expect(page.getByTestId("env-disk-version")).toBeVisible();
});

test("an unknown version says so, and the update button still works (FR-003/FR-006)", async ({ page }) => {
  // The default mock reports no process state → the running version is
  // unknown. The card must say so, and the action must not wait for a
  // version to appear.
  await openDiagnostics(page);

  await expect(page.getByTestId("pi-running-version-unknown")).toHaveText("unknown");
  await expect(page.getByTestId("pi-version")).toHaveText("1.4.0-mock");
  const update = page.getByTestId("pi-update");
  await expect(update).toBeVisible();
  await expect(update).toBeEnabled();
});

test("a long path is ellipsized, not broken in the middle (FR-002)", async ({ page }) => {
  await openDiagnostics(page);

  // The element that carries the ellipsis (the inner span is inline).
  const path = page.getByTestId("env-node-path");
  await expect(path).toBeVisible();

  const style = await path.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { wordBreak: cs.wordBreak, overflowWrap: cs.overflowWrap, textOverflow: cs.textOverflow };
  });
  // "break-all" is what cut the path in half; it must be gone.
  expect(style.wordBreak).not.toBe("break-all");
  expect(style.overflowWrap).not.toBe("break-all");
  expect(style.textOverflow).toBe("ellipsis");

  // The full path is still reachable — in the tooltip.
  const title = await page.getByTestId("env-pi-path-value").getAttribute("title");
  expect(title).toContain("/usr/local/bin/pi");
});

test("the card survives a 360px panel without overflowing (FR-007)", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await openDiagnostics(page);

  const r = await page.evaluate(() => {
    const de = document.documentElement;
    const card = document.querySelector('[data-testid="manage-env"]')!.getBoundingClientRect();
    const rows = Array.from(document.querySelectorAll(".diag-env-row")).map((el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, height: b.height };
    });
    return {
      overflow: de.scrollWidth - de.clientWidth,
      cardLeft: card.left,
      cardRight: card.right,
      rows,
    };
  });

  expect(r.overflow, "the document overflows horizontally").toBeLessThanOrEqual(0);
  for (const row of r.rows) {
    expect(row.left).toBeGreaterThanOrEqual(r.cardLeft - 0.5);
    expect(row.right).toBeLessThanOrEqual(r.cardRight + 0.5);
    // Every row is still readable — it has a height.
    expect(row.height).toBeGreaterThan(8);
  }
});

test("a failed probe says what is missing, it does not go blank (FR-006)", async ({ page }) => {
  await openDiagnostics(page, "envdegrade=1");

  await expect(page.getByTestId("env-node-missing")).toBeVisible();
  await expect(page.getByTestId("env-npm-missing")).toBeVisible();
  await expect(page.getByTestId("plugin-version")).toContainText("unknown");
  await expect(page.getByTestId("plugin-build")).toContainText("unknown");
});
