import { test, expect } from "@playwright/test";

async function openManage(page: import("@playwright/test").Page, query: string) {
  await page.goto(query ? `/?${query}` : "/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await expect(page.getByTestId("manage-view")).toBeVisible();
}

test.describe("manage view (MockBridge)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("tab-manage").click();
    await expect(page.getByTestId("manage-view")).toBeVisible();
    await expect(page.getByTestId("manage-env")).toContainText("1.4.0-mock");
  });

  test("mcp panel lists servers and supports add/remove flow", async ({ page }) => {
    await expect(page.getByTestId("mcp-server-row")).toHaveCount(3);
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

  // -- MCP enable / disable (spec 001 US1) ---------------------------------

  test("disabling a server keeps its configuration and enables it again", async ({ page }) => {
    const row = page.locator('[data-testid="mcp-server-row"]', { hasText: "filesystem" });
    await expect(row).toHaveAttribute("data-enabled", "true");
    await expect(row.getByTestId("mcp-scope-filesystem")).toHaveText("user");

    await page.getByTestId("mcp-toggle-filesystem").click();

    const toggle = page.getByTestId("mcp-toggle-filesystem");
    await expect(row).toHaveAttribute("data-enabled", "false");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveText("Disabled");
    // The row stays behind and says the configuration survived: disabling is
    // not removing (FR-003), and nothing has to be retyped.
    await expect(row).toContainText("configuration kept");
    // It was connected, so this session keeps the connection (FR-004).
    await expect(page.getByTestId("mcp-notice")).toContainText("next session");

    await toggle.click();
    await expect(row).toHaveAttribute("data-enabled", "true");
    await expect(toggle).toHaveText("Enabled");
  });

  test("the scope badge tells a project server from a user-level one", async ({ page }) => {
    const project = page.locator('[data-testid="mcp-server-row"]', { hasText: "internal-tools" });
    await expect(project.getByTestId("mcp-scope-internal-tools")).toHaveText("project");
    // pi reports a disabled entry with `enabled: false` and state "disabled".
    await expect(project).toHaveAttribute("data-enabled", "false");
    // Signing in to a server that is switched off is a dead end.
    await expect(project.getByRole("button", { name: "Login" })).toBeDisabled();

    await page.getByTestId("mcp-toggle-internal-tools").click();
    await expect(project).toHaveAttribute("data-enabled", "true");
    await expect(project.getByRole("button", { name: "Login" })).toBeEnabled();
  });

  test("an override that still decides the value is reported, not glossed over", async ({ page }) => {
    await openManage(page, "mcpoverride=1");
    await page.getByTestId("mcp-toggle-filesystem").click();

    // The write landed …
    await expect(page.getByTestId("mcp-server-row").first()).toHaveAttribute("data-enabled", "false");
    // … but the project keeps it running, and the panel says so instead of
    // showing a switch that lies.
    await expect(page.getByTestId("mcp-notice")).toContainText("stays enabled");
  });

  test("a failed write leaves the switch alone and shows the reason", async ({ page }) => {
    await openManage(page, "fail=mcp");
    await page.getByTestId("mcp-toggle-filesystem").click();

    await expect(page.getByTestId("outcome-banner")).toContainText("not valid JSON");
    // Optimistically flipping the switch would have been a lie.
    await expect(page.getByTestId("mcp-server-row").first()).toHaveAttribute("data-enabled", "true");
  });
});

test.describe("project trust (MockBridge)", () => {
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
