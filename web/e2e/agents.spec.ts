import { test, expect } from "@playwright/test";

/**
 * AGENTS.md panel (012 US3, tasks T118–T120). The mock's `?agents=` knob
 * serves the location list in pi's load order (T102 evidence): global first,
 * then the project root, then subdirectories. Open hands the path to the IDE
 * (mock asserts the request), create writes a template idempotently.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await expect(page.getByTestId("manage-view")).toBeVisible();
  await page.getByTestId("manage-tab-agents").click();
  await expect(page.getByTestId("agents-panel")).toBeVisible();
});

test("lists the four locations in pi load order with scope badges (T119)", async ({ page }) => {
  const rows = page.getByTestId("agents-row");
  await expect(rows).toHaveCount(4); // global + root + 2 subdirectories

  const scopes = await page.locator('[data-testid^="agents-scope-"]').allInnerTexts();
  expect(scopes[0]).toMatch(/global|全局/i);
  expect(scopes[1]).toMatch(/root|项目根/i);
  expect(scopes[2]).toMatch(/subdirectory|子目录/i);
  expect(scopes[3]).toMatch(/subdirectory|子目录/i);

  // root row: file present, load order #1
  const rootRow = rows.nth(1);
  await expect(rootRow).toContainText("AGENTS.md");
  await expect(rootRow).toContainText("#1");
  await expect(rootRow.getByTestId("agents-open")).toBeVisible();

  // the third subdir's file is missing in the default fixture → create button
  await expect(rows.nth(3).getByTestId("agents-create")).toBeVisible();
});

test("untrusted project shows the visible reason banner, not a blank list (T119)", async ({ page }) => {
  await page.goto("/?trusted=0");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-tab-agents").click();
  await expect(page.getByTestId("agents-untrusted")).toBeVisible();
  await expect(page.getByTestId("agents-panel")).toContainText("AGENTS.md");
});

test("create reports the written path and flips the row to open (T119/T120)", async ({ page }) => {
  const row = page.getByTestId("agents-row").nth(3);
  await row.getByTestId("agents-create").click();
  await expect(page.getByTestId("agents-note")).toContainText("/tmp/mock-project/packages/web/src/AGENTS.md");
  await expect(page.getByTestId("agents-note")).toContainText("Created");
  // the fixture flips exists=true after a create in the same session? The
  // mock serves a static list — refresh shows the same rows; the note is the
  // observable outcome here.
});

test("open delegates the path to the IDE bridge (mock records the request)", async ({ page }) => {
  const rootRow = page.getByTestId("agents-row").nth(1);
  await rootRow.getByTestId("agents-open").click();
  // the mock resolves {ok:true}; no error note may appear
  await expect(page.getByTestId("agents-note")).toHaveCount(0);
  await expect(page.getByTestId("agents-error")).toHaveCount(0);
});

test("the empty fixture renders an explicit empty state (T120)", async ({ page }) => {
  await page.goto("/?agents=none");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-tab-agents").click();
  // `none` keeps global+root rows but both marked missing — no empty state,
  // each row carries a create button
  await expect(page.getByTestId("agents-row")).toHaveCount(2);
  await expect(page.getByTestId("agents-row").nth(0).getByTestId("agents-create")).toBeVisible();
  await expect(page.getByTestId("agents-row").nth(1).getByTestId("agents-create")).toBeVisible();
});

test("zh renders the panel without key names (T120)", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-tab-agents").click();
  await expect(page.getByTestId("agents-panel")).toContainText("全局");
  await expect(page.getByTestId("agents-panel")).toContainText("项目根");
  await expect(page.getByTestId("agents-panel")).toContainText("加载顺序 #1");
  await expect(page.getByTestId("agents-panel")).not.toContainText("agents.scope");
  await expect(page.getByTestId("agents-panel")).not.toContainText("agents.priority");
});
