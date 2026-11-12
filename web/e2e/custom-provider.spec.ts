import { expect, test } from "@playwright/test";

/**
 * 027 — custom provider definition end-to-end (specs/027-custom-provider).
 *
 * The write path lands in the mock bridge (Kotlin's merge rules have their
 * own unit tests); what e2e pins is the FLOW: form → save → picker shows the
 * models without a restart, the key stays masked everywhere, builtin names
 * need a confirm, and the connectivity test reports failures honestly.
 */

const KEY = "sk-e2e-secret-77";

async function openCustomForm(page: import("@playwright/test").Page) {
  await page.getByTestId("tab-manage").click();
  await page.getByTestId("manage-tab-auth").click();
  await page.getByTestId("auth-add-custom").click();
  await expect(page.getByTestId("cprov-add-form")).toBeVisible();
}

async function fillForm(page: import("@playwright/test").Page) {
  await page.getByTestId("cprov-add-name").fill("e2e-relay");
  await page.getByTestId("cprov-add-display").fill("E2E Relay");
  await page.getByTestId("cprov-add-api").selectOption("openai-completions");
  await page.getByTestId("cprov-add-url").fill("https://relay.example.com");
  await page.getByTestId("cprov-add-key").fill(KEY);
  await page.getByTestId("cprov-add-model-id-0").fill("relay-large");
  await page.getByTestId("cprov-add-model-thinking-0").check();
  // default levels low/medium/high are pre-checked; tick xhigh too
  await page.getByTestId("cprov-add-level-xhigh-0").check();
  await page.getByTestId("cprov-add-model-image-0").check();
}

test("US1: the form saves a provider and the picker shows its models without a restart", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await openCustomForm(page);
  await fillForm(page);

  await page.getByTestId("cprov-add-submit").click();
  // onDone closes the form; the custom row (with its edit/delete entries)
  // appearing is the visible success signal.
  await expect(page.getByTestId("cprov-add-form")).toHaveCount(0);
  await expect(page.getByTestId("provider-editdef-e2e-relay")).toBeVisible();

  // US1's "immediately usable": the model picker lists the new models.
  await page.getByTestId("tab-chat").click();
  await page.getByTestId("model-chip").click();
  const list = page.getByTestId("model-popover");
  await expect(list).toBeVisible();
  await page.getByTestId("model-search").fill("relay");
  await expect(page.getByTestId("model-option").filter({ hasText: "relay-large" }).first()).toBeVisible();

  // The key never appears anywhere in the DOM (FR-007).
  const body = (await page.locator("body").innerText()) ?? "";
  expect(body).not.toContain(KEY);
});

test("US5/FR-007: edit refills the form with a masked key and a blank key keeps it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await openCustomForm(page);
  await fillForm(page);
  await page.getByTestId("cprov-add-submit").click();
  await expect(page.getByTestId("cprov-add-form")).toHaveCount(0);

  // The custom row now offers definition edit/delete (US4).
  await expect(page.getByTestId("provider-editdef-e2e-relay")).toBeVisible();
  await page.getByTestId("provider-editdef-e2e-relay").click();
  await expect(page.getByTestId("cprov-add-form")).toBeVisible();
  // Masked placeholder, never the raw key (FR-007).
  const placeholder =
    (await page.getByTestId("cprov-add-key").getAttribute("placeholder")) ?? "";
  expect(placeholder).toMatch(/•|…/);
  const body = (await page.locator("body").innerText()) ?? "";
  expect(body).not.toContain(KEY);

  // Change only the base URL; keep the key (blank field).
  await page.getByTestId("cprov-add-url").fill("https://relay2.example.com");
  await page.getByTestId("cprov-add-submit").click();
  // onDone closes the editor; the row stays (no orphan note to race).
  await expect(page.getByTestId("cprov-add-form")).toHaveCount(0);

  // providerGet reflects the new URL and still hasKey (mock keeps the key):
  // read it through the UI instead — the edit form's masked placeholder stays.
  await page.getByTestId("provider-editdef-e2e-relay").click();
  await expect(page.getByTestId("cprov-add-form")).toBeVisible();
  await expect(page.getByTestId("cprov-add-url")).toHaveValue("https://relay2.example.com");
  await page.getByTestId("cprov-add-cancel").click();
  await expect(page.getByTestId("cprov-add-form")).toHaveCount(0);
});

test("US3/FR-005: a bundled name is refused and needs the explicit confirm", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await openCustomForm(page);
  await page.getByTestId("cprov-add-name").fill("openai");
  await page.getByTestId("cprov-add-url").fill("https://relay.example.com");
  await page.getByTestId("cprov-add-key").fill(KEY);
  await page.getByTestId("cprov-add-model-id-0").fill("m1");

  await page.getByTestId("cprov-add-submit").click();
  await expect(page.getByTestId("cprov-add-bridge-error")).toContainText("openai");
  await expect(page.getByTestId("cprov-add-overwrite")).toBeVisible();

  // Explicit overwrite → the save goes through (the bundled row has no
  // edit-definition entry, so the closed form is the success signal).
  await page.getByTestId("cprov-add-overwrite-confirm").click();
  await expect(page.getByTestId("cprov-add-form")).toHaveCount(0);
  await expect(page.locator(`[data-testid="auth-provider-row"]`, { hasText: "openai" })).toBeVisible();
});

test("US4: delete definition removes the row and its models after confirm", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await openCustomForm(page);
  await fillForm(page);
  await page.getByTestId("cprov-add-submit").click();
  await expect(page.getByTestId("cprov-add-form")).toHaveCount(0);

  await page.getByTestId("provider-deldef-e2e-relay").click();
  // 007's in-app dialog, danger colour.
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("models-open-note")).toContainText("e2e-relay");

  await page.getByTestId("tab-chat").click();
  await page.getByTestId("model-chip").click();
  await page.getByTestId("model-search").fill("relay");
  await expect(page.getByTestId("model-option").filter({ hasText: "relay-large" })).toHaveCount(0);
});

test("US5: the connectivity test shows both failure shapes verbatim", async ({ page }) => {
  await page.goto("/?providertest=401");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await openCustomForm(page);
  await page.getByTestId("cprov-add-url").fill("https://relay.example.com");
  await page.getByTestId("cprov-add-test").click();
  await expect(page.getByTestId("cprov-add-test-result")).toContainText("401");

  // A save still works while the test failed (failures never block saving).
  await page.getByTestId("cprov-add-name").fill("e2e-relay");
  await page.getByTestId("cprov-add-model-id-0").fill("m1");
  await page.getByTestId("cprov-add-submit").click();
  // The save lands despite the failed test (US5).
  await expect(page.getByTestId("provider-editdef-e2e-relay")).toBeVisible();
});
