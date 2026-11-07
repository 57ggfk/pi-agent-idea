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

  // builtin provider picked from the dropdown; API key is the default method
  await page.getByTestId("provider-add-pick").selectOption("deepseek");
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

test("the method selector mirrors /login: account only where supported", async ({ page }) => {
  await page.getByTestId("auth-add").click();

  // deepseek is API-key only → the account segment is disabled
  await page.getByTestId("provider-add-pick").selectOption("deepseek");
  await expect(page.getByTestId("provider-add-method-account")).toBeDisabled();

  // anthropic supports OAuth → selecting it shows the account guidance card
  await page.getByTestId("provider-add-pick").selectOption("anthropic");
  await page.getByTestId("provider-add-method-account").click();
  await expect(page.getByTestId("provider-add-account-guide")).toBeVisible();
  await expect(page.getByTestId("provider-add-account-command")).toHaveText("/login anthropic");
  await expect(page.getByTestId("provider-add-account-copy")).toBeVisible();
  // no key route while the account method is selected
  await expect(page.getByTestId("provider-add-key")).toHaveCount(0);
  await expect(page.getByTestId("provider-add-submit")).toHaveCount(0);
});

test("validation: no provider, empty key and a bad custom name are refused (T129)", async ({ page }) => {
  await page.getByTestId("auth-add").click();

  // nothing selected → the save is refused before any write
  await page.getByTestId("provider-add-key").fill(SENTINEL);
  await page.getByTestId("provider-add-submit").click();
  await expect(page.getByTestId("provider-add-error")).toBeVisible();
  await expect(page.getByTestId("provider-add-saved")).toHaveCount(0);

  // a bad custom name keeps the old name contract error
  await page.getByTestId("provider-add-pick").selectOption(CUSTOM);
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
  await page.getByTestId("provider-add-pick").selectOption(CUSTOM);
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
  await page.getByTestId("provider-add-pick").selectOption(CUSTOM);
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
  await page.getByTestId("provider-setup-pick").selectOption(CUSTOM);
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
  await page.getByTestId("provider-add-pick").selectOption(CUSTOM);
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
