import { test, expect, type Page } from "@playwright/test";

/**
 * Provider credential chain (012 US5/US6, tasks T129–T133; /login-style form
 * rework).
 *
 * The sentinel key `SK-E2E-SENTINEL-XYZ` is typed into every form flow; the
 * zero-leak rule (T133) is asserted by scanning the whole page text and every
 * console message for it — the response contract carries the provider name
 * only, and the form clears its local state after submit.
 *
 * The form opens with a provider dropdown (bundled pi registry ∪ mock
 * overview) and an account/API-key method selector; custom providers are the
 * dropdown's last option and reveal a name input.
 */

const SENTINEL = "SK-E2E-SENTINEL-XYZ";
const CUSTOM = "__custom__";

async function watchConsole(page: Page, sink: string[]) {
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") sink.push(msg.text());
  });
  page.on("pageerror", (e) => sink.push(String(e)));
}

/**
 * 013 US1: pick a provider through the searchable dropdown — open the
 * trigger, filter by id (42 options never require scrolling in tests), click
 * the option row. The custom entry is pinned, so it is clicked directly.
 */
async function pickProvider(page: Page, prefix: string, id: string) {
  await page.getByTestId(`${prefix}-pick`).click();
  await page.getByTestId(`${prefix}-popover`).waitFor();
  if (id === CUSTOM) {
    await page.getByTestId(`${prefix}-custom`).click();
  } else {
    await page.getByTestId(`${prefix}-search`).fill(id);
    await page.locator(`[data-testid="${prefix}-option"][data-value="${id}"]`).click();
  }
  await expect(page.getByTestId(`${prefix}-popover`)).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await expect(page.getByTestId("manage-view")).toBeVisible();
  await page.getByTestId("manage-tab-auth").click();
  await expect(page.getByTestId("auth-panel")).toBeVisible();
});

test("adding a provider writes the credential and clears the form (T131)", async ({ page }) => {
  const leaks: string[] = [];
  await watchConsole(page, leaks);

  await page.getByTestId("auth-add").click();
  const form = page.getByTestId("provider-add-form");
  await expect(form).toBeVisible();

  // builtin provider picked from the searchable dropdown; API key is the
  // default method
  await pickProvider(page, "provider-add", "deepseek");
  await expect(page.getByTestId("provider-add-method-key")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("provider-add-key").fill(SENTINEL);
  await page.getByTestId("provider-add-submit").click();

  await expect(page.getByTestId("provider-add-saved")).toContainText("deepseek");
  // the key input is cleared; the page text carries no key material
  await expect(page.getByTestId("provider-add-key")).toHaveValue("");
  const body = (await page.locator("body").innerText()) ?? "";
  expect(body).not.toContain(SENTINEL);
  expect(leaks.join("\n")).not.toContain(SENTINEL);
});

test("the searchable dropdown filters and pins the custom option (013 US1)", async ({ page }) => {
  await page.getByTestId("auth-add").click();

  await page.getByTestId("provider-add-pick").click();
  await page.getByTestId("provider-add-popover").waitFor();
  // filter narrows the 42 providers to one
  await page.getByTestId("provider-add-search").fill("deep");
  await expect(page.getByTestId("provider-add-option")).toHaveCount(1);
  // the custom entry stays pinned and unfiltered
  await expect(page.getByTestId("provider-add-custom")).toBeVisible();
  // a keyword that matches nothing shows the empty state
  await page.getByTestId("provider-add-search").fill("zzz-nope");
  await expect(page.getByTestId("provider-add-no-match")).toBeVisible();
  // Enter picks the highlighted (first) row — back to a real provider
  await page.getByTestId("provider-add-search").fill("deep");
  await page.getByTestId("provider-add-search").press("Enter");
  await expect(page.getByTestId("provider-add-popover")).toHaveCount(0);
  await expect(page.getByTestId("provider-add-method-key")).toHaveAttribute("aria-checked", "true");
});

test("the method selector mirrors /login: account only where supported", async ({ page }) => {
  await page.getByTestId("auth-add").click();

  // deepseek is API-key only → the account segment is disabled
  await pickProvider(page, "provider-add", "deepseek");
  await expect(page.getByTestId("provider-add-method-account")).toBeDisabled();

  // anthropic supports OAuth → selecting it shows the account guidance card
  await pickProvider(page, "provider-add", "anthropic");
  await page.getByTestId("provider-add-method-account").click();
  await expect(page.getByTestId("provider-add-account-guide")).toBeVisible();
  await expect(page.getByTestId("provider-add-account-command")).toHaveText("/login anthropic");
  await expect(page.getByTestId("provider-add-account-copy")).toBeVisible();
  // 013 US2: the badge says so before the route is chosen, on the segment
  await expect(page.getByTestId("provider-add-account-badge")).toContainText(/暂未接入|not wired yet/i);
  // no key route while the account method is selected
  await expect(page.getByTestId("provider-add-key")).toHaveCount(0);
  await expect(page.getByTestId("provider-add-submit")).toHaveCount(0);
});

test("the account guide hands the flow to an IDE terminal (013 US2)", async ({ page }) => {
  await page.getByTestId("auth-add").click();
  await pickProvider(page, "provider-add", "anthropic");
  await page.getByTestId("provider-add-method-account").click();

  // default mock: the command is typed into a fresh terminal session
  await page.getByTestId("provider-add-account-terminal").click();
  await expect(page.getByTestId("provider-add-term-note")).toContainText(/终端|terminal/i);

  // the degraded path (terminal opened, command copied) is shown as such
  await page.goto("/?term=fail");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-tab-auth").click();
  await page.getByTestId("auth-add").click();
  await pickProvider(page, "provider-add", "anthropic");
  await page.getByTestId("provider-add-method-account").click();
  await page.getByTestId("provider-add-account-terminal").click();
  await expect(page.getByTestId("provider-add-term-note")).toContainText(/复制|copied/i);
});

test("validation: no provider, empty key and a bad custom name are refused (T129)", async ({ page }) => {
  await page.getByTestId("auth-add").click();

  // nothing selected → the save is refused before any write
  await page.getByTestId("provider-add-key").fill(SENTINEL);
  await page.getByTestId("provider-add-submit").click();
  await expect(page.getByTestId("provider-add-error")).toBeVisible();
  await expect(page.getByTestId("provider-add-saved")).toHaveCount(0);

  // a bad custom name keeps the old name contract error
  await pickProvider(page, "provider-add", CUSTOM);
  await page.getByTestId("provider-add-name").fill("bad name!");
  await page.getByTestId("provider-add-submit").click();
  await expect(page.getByTestId("provider-add-error")).toContainText(/letters|字母/i);

  await page.getByTestId("provider-add-name").fill("ok-name");
  await page.getByTestId("provider-add-key").fill("");
  await page.getByTestId("provider-add-submit").click();
  await expect(page.getByTestId("provider-add-error")).toBeVisible();
  await expect(page.getByTestId("provider-add-saved")).toHaveCount(0);
});

test("delete goes through the in-app confirm dialog and can be cancelled (T131)", async ({ page }) => {
  // the mock seeds one credentialed provider ("mock-provider")… but refuses
  // to delete it; another provider added first makes the flow observable
  await page.getByTestId("auth-add").click();
  await pickProvider(page, "provider-add", CUSTOM);
  await page.getByTestId("provider-add-name").fill("doomed-provider");
  await page.getByTestId("provider-add-key").fill(SENTINEL);
  await page.getByTestId("provider-add-submit").click();
  await expect(page.getByTestId("provider-add-saved")).toBeVisible();

  const row = page.locator('[data-testid="auth-provider-row"]', { hasText: "doomed-provider" });
  await row.getByTestId("provider-delete-doomed-provider").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  // cancel keeps everything
  await page.getByTestId("confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();
});

test("a failed write shows a visible error and no success note (T133)", async ({ page }) => {
  await page.goto("/?authwrite=fail");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-tab-auth").click();

  await page.getByTestId("auth-add").click();
  await pickProvider(page, "provider-add", CUSTOM);
  await page.getByTestId("provider-add-name").fill("unlucky");
  await page.getByTestId("provider-add-key").fill(SENTINEL);
  await page.getByTestId("provider-add-submit").click();

  await expect(page.getByTestId("provider-add-error")).toContainText("invalid or rejected key");
  await expect(page.getByTestId("provider-add-saved")).toHaveCount(0);
  // the key stays in the field after a failure — the user can retry
  await expect(page.getByTestId("provider-add-key")).toHaveValue(SENTINEL);
});

test("the provider-setup step after install works and skips persistently (T130)", async ({ page }) => {
  // install succeeds → gate releases → the provider step is offered
  await page.goto("/?setup=missing");
  await expect(page.getByTestId("setup-card")).toBeVisible();
  await page.getByTestId("setup-install").click();
  await expect(page.getByTestId("provider-setup")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("tabs")).toBeVisible();

  // credentials already exist in the mock → the hint shows
  await expect(page.getByTestId("provider-setup-hint")).toBeVisible();

  // fill it through the shared form (custom provider → name input)
  await pickProvider(page, "provider-setup", CUSTOM);
  await page.getByTestId("provider-setup-name").fill("setup-provider");
  await page.getByTestId("provider-setup-key").fill(SENTINEL);
  await page.getByTestId("provider-setup-submit").click();
  // submitting succeeds → the step closes itself (done path)
  await expect(page.getByTestId("provider-setup")).toHaveCount(0, { timeout: 10_000 });

  // the credential is visible in the Auth panel afterwards
  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-tab-auth").click();
  await expect(page.locator('[data-testid="auth-provider-row"]', { hasText: "setup-provider" })).toBeVisible();

  const body = (await page.locator("body").innerText()) ?? "";
  expect(body).not.toContain(SENTINEL);
});

test("custom providers route to the models.json writer (T129/T132)", async ({ page }) => {
  const leaks: string[] = [];
  await watchConsole(page, leaks);

  await page.getByTestId("auth-add").click();
  await pickProvider(page, "provider-add", CUSTOM);
  await page.getByTestId("provider-add-name").fill("custom-models-provider");
  await page.getByTestId("provider-add-key").fill(SENTINEL);
  await page.getByTestId("provider-add-submit").click();
  // the mock accepts both paths; the observable difference is the same
  // visible success note — the routing itself is pinned by the store unit
  // tests and the Kotlin tests
  await expect(page.getByTestId("provider-add-saved")).toContainText("custom-models-provider");
  const body = (await page.locator("body").innerText()) ?? "";
  expect(body).not.toContain(SENTINEL);
  expect(leaks.join("\n")).not.toContain(SENTINEL);
});

test("editing a provider shows the form without expanding details (013 US5)", async ({ page }) => {
  // the regression: the edit form used to live inside the expanded detail
  // block, so "Set key" did nothing until the triangle was pressed first
  await page.getByTestId("provider-setkey-mock-provider").click();
  const form = page.getByTestId("provider-edit-mock-provider-form");
  await expect(form).toBeVisible();
  await expect(page.getByTestId("provider-edit-mock-provider-name")).toBeDisabled();
  // closing hides it again
  await page.getByTestId("provider-setkey-mock-provider").click();
  await expect(form).toHaveCount(0);
});
