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
    // One user skill and one project-level skill: the panel must distinguish them.
    await expect(page.getByTestId("skill-row")).toHaveCount(2);
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

test.describe("project trust (MockBridge)", () => {
  /** Opens the manage tab on a specific trust scenario. */
  async function openManage(page: import("@playwright/test").Page, query: string) {
    await page.goto(query ? `/?${query}` : "/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("tab-manage").click();
    await expect(page.getByTestId("manage-view")).toBeVisible();
  }

  test("untrusted project explains which resources are inert and can be trusted", async ({ page }) => {
    await openManage(page, "trusted=0");

    const banner = page.getByTestId("trust-banner");
    await expect(banner).toHaveAttribute("data-state", "untrusted");
    await expect(banner).toContainText("尚未被 pi 信任");
    for (const type of ["skills", "mcp", "settings", "extensions"]) {
      await expect(banner.locator(`[data-resource="${type}"]`)).toBeVisible();
    }

    await page.getByTestId("trust-grant").click();
    const confirm = page.getByTestId("trust-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm.locator("li")).toHaveCount(4);
    await page.getByTestId("trust-confirm-yes").click();

    await expect(page.getByTestId("trust-banner")).toHaveCount(0);
    await expect(page.getByTestId("trust-status")).toHaveAttribute("data-state", "trusted");
  });

  test("trusted project shows a status line, and revoke brings the banner back", async ({ page }) => {
    await openManage(page, "");

    await expect(page.getByTestId("trust-status")).toHaveAttribute("data-state", "trusted");
    await expect(page.getByTestId("trust-banner")).toHaveCount(0);

    await page.getByTestId("trust-revoke").click();
    await expect(page.getByTestId("trust-confirm")).toHaveAttribute("data-action", "revoke");
    await page.getByTestId("trust-confirm-yes").click();

    await expect(page.getByTestId("trust-banner")).toHaveAttribute("data-state", "untrusted");
    await expect(page.getByTestId("trust-status")).toHaveCount(0);
  });

  test("an unreadable trust.json is surfaced and never reads as trusted", async ({ page }) => {
    await openManage(page, "trust=broken");

    const banner = page.getByTestId("trust-banner");
    await expect(banner).toHaveAttribute("data-state", "error");
    await expect(banner).toContainText("无法读取信任配置");
    // No grant button: writing over a store we cannot parse would drop other
    // projects' trust entries.
    await expect(page.getByTestId("trust-grant")).toHaveCount(0);
    await expect(page.getByTestId("trust-retry")).toBeVisible();
  });

  test("project-level skills are marked inert while the project is untrusted", async ({ page }) => {
    await openManage(page, "trusted=0");
    await page.getByTestId("manage-tab-skills").click();

    const projectRow = page.locator('[data-testid="skill-row"][data-scope="project"]');
    await expect(projectRow).toHaveCount(1);
    await expect(projectRow).toHaveAttribute("data-active", "false");
    await expect(projectRow.getByTestId("skill-scope")).toContainText("未生效");
    await expect(projectRow.getByTestId("skill-inert-reason")).toBeVisible();

    const userRow = page.locator('[data-testid="skill-row"][data-scope="user"]');
    await expect(userRow).toHaveAttribute("data-active", "true", { timeout: 5_000 });
    await expect(userRow.getByTestId("skill-scope")).toContainText("用户级");
  });
});
