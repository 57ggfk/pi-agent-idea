import { test, expect } from "@playwright/test";
// Importing App pulls the whole UI graph (bridge, store, components) — this
// doubles as a compile/load smoke test outside the browser bundle.
import App, { ErrorBoundary } from "../src/App";

/**
 * Feature e2e against the MockBridge (vite dev server): @ file completion,
 * code-block copy button, error boundary.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
});

test("@ file completion filters and inserts the selected path", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.pressSequentially("@sto");
  const menu = page.getByTestId("file-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".file-item")).toHaveCount(1);
  await expect(menu.locator(".file-item").first()).toContainText("src/store/store.ts");

  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("@src/store/store.ts ");
  // Menu closes once the token is complete (trailing space ends the query).
  await expect(menu).toBeHidden();
});

test("@ file menu escape closes the menu but keeps the typed text", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.pressSequentially("@");
  await expect(page.getByTestId("file-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("file-menu")).toBeHidden();
  await expect(input).toHaveValue("@");
});

test("code block copy button copies the code and flashes a check", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("composer-input").fill("show me a code block");
  await page.getByTestId("send-btn").click();

  // The file-link at the end of the final answer marks a settled stream —
  // clicking mid-stream would copy a partial block.
  await expect(page.locator(".markdown .file-link[data-path='src/store/store.ts']").first()).toBeVisible({
    timeout: 30_000,
  });

  const copyBtn = page.locator(".code-copy-btn").first();
  await expect(copyBtn).toBeVisible();
  await copyBtn.click();
  await expect(copyBtn).toHaveText("✓");
  await expect(copyBtn).toHaveText("Copy", { timeout: 5_000 });

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip.replace(/\n+$/, "")).toBe("echo hello from mock pi");
});

test("error boundary wraps the app and is exported", async ({ page }) => {
  expect(typeof App).toBe("function");
  expect(typeof ErrorBoundary).toBe("function");
  // The whole app renders inside the boundary (no crash on boot).
  await expect(page.getByTestId("message-list")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
});

test("edit tool call renders a diff preview", async ({ page }) => {
  await page.getByTestId("composer-input").fill("edit something");
  await page.getByTestId("send-btn").click();
  const editCard = page.locator(".tool-card", { has: page.locator(".tool-name", { hasText: "edit" }) });
  await expect(editCard).toBeVisible({ timeout: 30_000 });

  const diff = editCard.locator(".tool-diff");
  await expect(diff).toBeVisible();
  await expect(diff.locator(".diff-del").first()).toContainText("createRoot");
  await expect(diff.locator(".diff-add", { hasText: "StrictMode" }).first()).toBeVisible();
  // Well under the 500-line cap: no Show all button.
  await expect(diff.locator(".diff-show-all")).toHaveCount(0);
});

test("file path references render as clickable ide.openFile links", async ({ page }) => {
  await page.getByTestId("composer-input").fill("reference files");
  await page.getByTestId("send-btn").click();
  // Plain-text reference in the final answer, linkified with its :line suffix.
  const link = page.locator(".markdown .file-link[data-path='src/store/store.ts']").first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(link).toHaveAttribute("data-line", "1");
  // http(s) "paths" must never be linkified.
  await expect(page.locator(".markdown .file-link[data-path^='http']")).toHaveCount(0);
});

test("edit tool card links its file and offers the IDE diff viewer", async ({ page }) => {
  await page.getByTestId("composer-input").fill("edit something");
  await page.getByTestId("send-btn").click();
  const editCard = page.locator(".tool-card", { has: page.locator(".tool-name", { hasText: "edit" }) });
  await expect(editCard).toBeVisible({ timeout: 30_000 });

  // The file path in the card is clickable (opens the file in the IDE).
  const fileLink = editCard.locator(".tool-file-link");
  await expect(fileLink).toBeVisible();
  await expect(fileLink).toContainText("src/main.tsx");

  // The Diff button launches the IDE's native diff viewer (mock resolves).
  const diffBtn = editCard.getByTestId("tool-diff-btn");
  await expect(diffBtn).toBeVisible();
  await diffBtn.click();
});
