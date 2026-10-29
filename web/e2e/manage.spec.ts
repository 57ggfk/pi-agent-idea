import { test, expect } from "@playwright/test";

test.describe("manage view (MockBridge)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("tab-manage").click();
    await expect(page.getByTestId("manage-view")).toBeVisible();
    await expect(page.getByTestId("manage-env")).toContainText("1.4.0-mock");
  });

  test("mcp panel lists servers and supports add/remove flow", async ({ page }) => {
    await expect(page.getByTestId("mcp-server-row")).toHaveCount(2);
    await expect(page.getByTestId("mcp-server-row").first()).toContainText("filesystem");

    // Add form submits and refreshes
    await page.getByTestId("mcp-add-toggle").click();
    await page.locator('[data-testid="mcp-add-form"] input').first().fill("tools");
    await page.locator('[data-testid="mcp-add-form"] input').nth(1).fill("uvx");
    await page.getByTestId("mcp-add-submit").click();
    await expect(page.getByTestId("outcome-banner")).toContainText("✓");

    // Remove keeps the panel consistent
    await page.getByTestId("mcp-remove-filesystem").click();
    await expect(page.getByTestId("outcome-banner")).toContainText("✓");
  });

  test("packages panel shows install line and accepts sources", async ({ page }) => {
    await page.getByTestId("manage-tab-packages").click();
    await expect(page.getByTestId("package-row")).toHaveCount(1);
    await page.locator(".packages-input").fill("npm:@example/pi-extra");
    await page.getByTestId("package-install").click();
    await expect(page.getByTestId("outcome-banner")).toContainText("✓");
  });

  test("skills panel lists and creates skills", async ({ page }) => {
    await page.getByTestId("manage-tab-skills").click();
    await expect(page.getByTestId("skill-row")).toHaveCount(1);
    await expect(page.getByTestId("skill-row").first()).toContainText("pdf-tools");

    await page.getByTestId("skills-new-toggle").click();
    await page.locator('[data-testid="skills-form"] input').first().fill("code-review");
    await page.getByTestId("skills-create").click();
    await expect(page.getByTestId("outcome-banner")).toContainText("✓");
  });

  test("auth panel checks provider credentials", async ({ page }) => {
    await page.getByTestId("manage-tab-auth").click();
    await expect(page.getByTestId("auth-provider-row")).toHaveCount(1);
    await page.getByTestId("auth-check-mock-provider").click();
    await expect(page.getByTestId("auth-provider-row")).toContainText("ready", { timeout: 15_000 });
  });

  test("settings panel loads and saves valid json", async ({ page }) => {
    await page.getByTestId("manage-tab-settings").click();
    const editor = page.getByTestId("settings-editor");
    await expect(editor).toHaveValue(/\\"theme\\"|"theme"/);
    await editor.fill('{\n  "theme": "dark",\n  "quietStartup": true\n}');
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("outcome-banner")).toContainText("✓");
  });
});
