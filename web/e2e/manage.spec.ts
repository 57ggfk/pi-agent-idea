import { test, expect } from "@playwright/test";

async function openManage(page: import("@playwright/test").Page, query: string) {
  await page.goto(query ? `/?${query}` : "/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await expect(page.getByTestId("manage-view")).toBeVisible();
}

async function openDiagnostics(page: import("@playwright/test").Page) {
  // The pi environment (version, paths, update) lives in the diagnostics tab.
  await page.getByTestId("manage-tab-diagnostics").click();
  await expect(page.getByTestId("diagnostics-panel")).toBeVisible();
  await expect(page.getByTestId("manage-env")).toContainText("1.4.0-mock");
}

test.describe("manage view (MockBridge)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("tab-manage").click();
    await expect(page.getByTestId("manage-view")).toBeVisible();
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

  // -- Package update (spec 001 US2) ----------------------------------------

  test("package update refreshes the version in the list", async ({ page }) => {
    await page.getByTestId("manage-tab-packages").click();
    await expect(page.getByTestId("package-row")).toContainText("1.0.0");

    await page.getByTestId("package-update-0").click();

    await expect(page.getByTestId("update-result")).toContainText(
      "updated npm:@example/pi-tools@1.0.0 -> npm:@example/pi-tools@1.1.0",
    );
    await expect(page.getByTestId("package-row")).toContainText("1.1.0");
  });

  test("a failed package update shows the raw output and the stale-version note", async ({ page }) => {
    await openManage(page, "fail=update");
    await page.getByTestId("manage-tab-packages").click();
    await page.getByTestId("package-update-0").click();

    const result = page.getByTestId("update-result");
    await expect(result).toContainText("npm error 404");
    await expect(result).toContainText("exit code 1");
    await expect(result).toContainText("may still be the old one");
    // A failed update must not silently bump the listed version.
    await expect(page.getByTestId("package-row")).toContainText("1.0.0");
  });

  // -- pi self-update (spec 001 US3) -----------------------------------------

  test("pi update from diagnostics refreshes the version without a confirm", async ({ page }) => {
    // Default mock reports no pi-state events: no process running, no gate.
    await openDiagnostics(page);
    await page.getByTestId("pi-update").click();
    await expect(page.getByTestId("env-update-confirm")).toHaveCount(0);
    await expect(page.getByTestId("env-update-result")).toContainText("updated to 1.5.0-mock", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("pi-version")).toHaveText("1.5.0-mock");
  });

  test("updating pi while a session is running asks first, and cancel does nothing", async ({ page }) => {
    await openManage(page, "pistate=1");
    // pi reports running ~300ms after load (mock pi-state events).
    await expect(page.getByTestId("status-dot")).toHaveClass(/running/, { timeout: 5_000 });
    await openDiagnostics(page);

    await page.getByTestId("pi-update").click();
    const confirm = page.getByTestId("env-update-confirm");
    await expect(confirm).toBeVisible();

    await page.getByTestId("env-update-confirm-no").click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId("pi-version")).toHaveText("1.4.0-mock");

    await page.getByTestId("pi-update").click();
    await expect(confirm).toBeVisible();
    await page.getByTestId("env-update-confirm-yes").click();
    await expect(page.getByTestId("pi-version")).toHaveText("1.5.0-mock", { timeout: 15_000 });
  });

  test("a failed pi update shows the raw error", async ({ page }) => {
    await openManage(page, "fail=update");
    await openDiagnostics(page);
    await page.getByTestId("pi-update").click();
    await expect(page.getByTestId("env-update-result")).toContainText("EACCES", { timeout: 15_000 });
  });

  // -- Provider details (spec 001 US4) ----------------------------------------

  test("provider details expand with configured flags and no secret values", async ({ page }) => {
    await page.getByTestId("manage-tab-auth").click();
    const toggle = page.getByTestId("provider-toggle-mock-provider");
    await toggle.click();

    const detail = page.getByTestId("provider-detail-mock-provider");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("openai_completions");
    await expect(detail).toContainText("https://api.mock.dev/v1");
    // Sensitive keys show a flag, never a value (FR-011).
    await expect(detail.getByTestId("provider-config-apiKey")).toContainText("configured");
    await expect(detail.getByTestId("provider-config-Authorization")).toContainText("not configured");
    await expect(detail).not.toContainText(/sk-|Bearer /);

    // 013 US4: arrays (models) render as formatted multi-line JSON in a
    // scrollable block, not a compact one-liner; the wrap toggle flips it.
    const models = detail.getByTestId("provider-config-json-models");
    await expect(models).toBeVisible();
    expect((await models.innerText()).split("\n").length).toBeGreaterThan(3);
    const wrap = page.getByTestId("provider-wrap-toggle");
    await expect(wrap).toHaveAttribute("aria-pressed", "false");
    await wrap.click();
    await expect(models).toHaveClass(/provider-config-json-wrap/);
    await expect(wrap).toHaveAttribute("aria-pressed", "true");

    // 013 US3: the toggle row is a real aria-expanded chevron button.
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await page.getByTestId("provider-open-file-mock-provider").click();
    await expect(page.getByTestId("models-open-note")).toContainText("models.json");
  });

  test("a corrupt models.json is explained with the parse position", async ({ page }) => {
    await openManage(page, "models=broken");
    await page.getByTestId("manage-tab-auth").click();

    const state = page.getByTestId("models-state");
    await expect(state).toHaveAttribute("data-state", "corrupt");
    await expect(state).toContainText("not valid JSON");
    await expect(state).toContainText("line 3, column 8");
    // The panel must not go blank over it: the provider list still renders.
    await expect(page.getByTestId("auth-provider-row")).toHaveCount(1);
  });

  test("a missing models.json says nothing is configured yet", async ({ page }) => {
    await openManage(page, "models=missing");
    await page.getByTestId("manage-tab-auth").click();

    const state = page.getByTestId("models-state");
    await expect(state).toHaveAttribute("data-state", "missing");
    await expect(state).toContainText("not found");
    await expect(state).toContainText("no custom providers configured yet");
  });
});

test.describe("project trust (MockBridge)", () => {
  test("untrusted project explains which resources are inert and can be trusted", async ({ page }) => {
    await openManage(page, "trusted=0");

    const banner = page.getByTestId("trust-banner");
    await expect(banner).toHaveAttribute("data-state", "untrusted");
    await expect(banner.getByTestId("trust-grant")).toBeVisible();
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
    await expect(banner.getByTestId("trust-retry")).toBeVisible();
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
    await expect(projectRow.getByTestId("skill-scope")).toHaveAttribute("data-inert", "true");
    await expect(projectRow.getByTestId("skill-inert-reason")).toBeVisible();

    const userRow = page.locator('[data-testid="skill-row"][data-scope="user"]');
    await expect(userRow).toHaveAttribute("data-active", "true", { timeout: 5_000 });
    await expect(userRow.getByTestId("skill-scope")).toContainText("用户级");
  });

});
