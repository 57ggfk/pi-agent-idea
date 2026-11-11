import { expect, test } from "@playwright/test";

/**
 * 028 — install guide: three routes, the corrected Node gate, nodePath.
 * All state comes from the mock knobs (?setup=nonode|nodeold|missing), so
 * none of this depends on the real machine.
 */

test("FR-001/009: with no node, npm is refused with the reason and the script route is offered", async ({ page }) => {
  await page.goto("/?setup=nonode");
  await expect(page.getByTestId("setup-card")).toBeVisible();

  // The npm route is OFF and the panel says WHY (no node — not "npm missing").
  await expect(page.getByTestId("setup-no-npm")).toContainText(/Node/i);
  // The vendor script block shows the full command with the URL BEFORE running.
  await expect(page.getByTestId("setup-script-command")).toContainText("pi.dev/install");
  await page.getByTestId("setup-script-open").click();
  await expect(page.getByTestId("setup-script-confirm")).toBeVisible();
});

test("FR-002/US1: confirming the script installs and releases the gate", async ({ page }) => {
  await page.goto("/?setup=nonode");
  await expect(page.getByTestId("setup-card")).toBeVisible();

  await page.getByTestId("setup-script-open").click();
  await page.getByTestId("setup-script-run").click();
  // The mock's success re-detects with pi found → the gate releases and the
  // provider step (027's shared form) appears (US5).
  await expect(page.getByTestId("provider-setup")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("setup-card")).toHaveCount(0);
});

test("FR-003/US3: an old node names the required version and the found one", async ({ page }) => {
  await page.goto("/?setup=nodeold");
  await expect(page.getByTestId("setup-card")).toBeVisible();
  await expect(page.getByTestId("setup-node-warning")).toContainText("22.19");
  await expect(page.getByTestId("setup-node-warning")).toContainText("v20.11.0");
  // The npm route is off (node-version), the script is still offered.
  await expect(page.getByTestId("setup-no-npm")).toContainText(/22\.19/);
  await expect(page.getByTestId("setup-script-command")).toContainText("pi.dev/install");
});
