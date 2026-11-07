import { expect, test } from "@playwright/test";

/**
 * First-run setup (012 US4): the tool window is EXCLUSIVE while pi is
 * missing — the guide is the only thing mounted (tabs, chat, sessions,
 * manage, status bar, composer, confirm: all `toHaveCount(0)`, never just
 * invisible). The registry choice is the part that breaks on an intranet:
 * pinning registry.npmjs.org overrides a working `.npmrc`, so "no --registry
 * flag" is an assertion, not a comment. Only a working pi releases the gate;
 * a stopped install keeps it (T124), and a failed DETECTION never locks the
 * UI (T122 fallback).
 */

/** The six element classes that must not exist in exclusive mode (T122). */
async function expectExclusive(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("tabs")).toHaveCount(0);
  await expect(page.getByTestId("message-list")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toHaveCount(0);
  await expect(page.getByTestId("statusbar")).toHaveCount(0);
  await expect(page.getByTestId("sessions-view")).toHaveCount(0);
  await expect(page.getByTestId("manage-view")).toHaveCount(0);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(page.getByTestId("setup-card")).toBeVisible();
}

test("#1 npm's own registry is the default and passes no --registry", async ({ page }) => {
  await page.goto("/?setup=missing&npmregistry=https://registry.corp.example.com/&install=fail");

  const card = page.getByTestId("setup-card");
  await expect(card).toBeVisible();
  await expectExclusive(page);

  const npmDefault = page.getByTestId("setup-source-default");
  await expect(npmDefault).toContainText("npm default");
  await expect(npmDefault).toContainText("registry.corp.example.com");
  await expect(npmDefault.locator("input")).toBeChecked();

  await page.getByTestId("setup-install").click();
  await expect(page.getByTestId("setup-log")).toContainText("(npm default registry)");
  await expect(page.getByTestId("setup-log")).not.toContainText("--registry=");
});

test("#2 the China mirror is still one click away", async ({ page }) => {
  await page.goto("/?setup=missing&install=fail");

  await page.getByTestId("setup-source-china").locator("input").check();
  await page.getByTestId("setup-install").click();
  await expect(page.getByTestId("setup-log")).toContainText(
    "--registry=https://registry.npmmirror.com",
  );
});

test("#3 a pasted custom registry is sent verbatim", async ({ page }) => {
  await page.goto("/?setup=missing&install=fail");

  await page.getByTestId("setup-source-custom").locator("input").check();

  const input = page.getByTestId("setup-registry-input");
  await expect(input).toBeVisible();
  await expect(page.getByTestId("setup-install")).toBeDisabled();

  await input.fill("http://nexus.corp.local:8081/repository/npm-group");
  await expect(page.getByTestId("setup-install")).toBeEnabled();
  await page.getByTestId("setup-install").click();

  await expect(page.getByTestId("setup-log")).toContainText(
    "--registry=http://nexus.corp.local:8081/repository/npm-group",
  );
});

test("#4 a failed install keeps the exclusive gate and both routes (rewritten, T125)", async ({ page }) => {
  await page.goto("/?setup=missing&install=fail");

  await page.getByTestId("setup-install").click();
  await expect(page.getByTestId("setup-error")).toContainText("registry was unreachable");
  // The gate still holds — nothing else mounted.
  await expectExclusive(page);
  // Both routes stay available after a failure.
  await expect(page.getByTestId("setup-path-input")).toBeVisible();
  await expect(page.getByTestId("setup-install")).toBeEnabled();
});

test("#5 a successful install releases the gate (rewritten, T125)", async ({ page }) => {
  await page.goto("/?setup=missing");

  await expect(page.getByTestId("setup-card")).toBeVisible();
  await expectExclusive(page);

  await page.getByTestId("setup-install").click();
  // the guide disappears AND the main UI actually mounts
  await expect(page.getByTestId("setup-card")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("tabs")).toBeVisible();
  await expect(page.getByTestId("message-list")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
});

test("#6 without node there is no install button, only a link and the manual path", async ({
  page,
}) => {
  await page.goto("/?setup=nonode");

  await expect(page.getByTestId("setup-node-warning")).toBeVisible();
  await expect(page.getByTestId("setup-no-npm")).toBeVisible();
  await expect(page.getByTestId("setup-install")).toHaveCount(0);
  await expect(page.getByTestId("setup-path-input")).toBeVisible();
  await expectExclusive(page);
});

test("#7 stopping an install keeps the gate and brings the button back (rewritten, T125)", async ({ page }) => {
  // `?install=hang`: npm never returns on its own, so only the Stop button can
  // end it. This is what an install on a slow mirror looks like from the UI.
  await page.goto("/?setup=missing&install=hang");

  await page.getByTestId("setup-install").click();
  await expect(page.getByTestId("setup-cancel")).toBeVisible();
  await expect(page.getByTestId("setup-install")).toContainText(/Installing… \d+s/);

  await page.getByTestId("setup-cancel").click();
  await expect(page.getByTestId("setup-notice")).toContainText("Install stopped");
  // Back to a usable GUIDE: no Stop button, install offered again…
  await expect(page.getByTestId("setup-cancel")).toHaveCount(0);
  await expect(page.getByTestId("setup-install")).toBeEnabled();
  await expect(page.getByTestId("setup-card")).toBeVisible();
  // …and the gate still holds: stopping is not a way into the main UI (T124).
  await expect(page.getByTestId("tabs")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toHaveCount(0);
});

test("#8 the exclusive screen cannot be switched away from (T122/T121)", async ({ page }) => {
  await page.goto("/?setup=missing");
  await expect(page.getByTestId("setup-card")).toBeVisible();

  // Esc does nothing (no dialog exists to close), the tab bar does not exist,
  // and a programmatic setTab is a no-op — the store refuses while gated.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("setup-card")).toBeVisible();
  await expect(page.getByTestId("tabs")).toHaveCount(0);
  await expectExclusive(page);
});

test("#9 a failed detection never locks the UI — visible error + retry (T122 fallback)", async ({ page }) => {
  // `error1`: the first detection fails, a retry recovers.
  await page.goto("/?setup=error1");

  // the main UI mounts…
  await expect(page.getByTestId("tabs")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  // …with the visible error and a retry button, not a locked window
  const banner = page.getByTestId("setup-gate-error");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("detection failed");

  await page.getByTestId("setup-gate-retry").click();
  // the retry recovers into… the exclusive guide (pi really is missing) —
  // the error banner is gone, the guide is up, the main UI is gone again
  await expect(page.getByTestId("setup-gate-error")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("setup-card")).toBeVisible();
  await expect(page.getByTestId("tabs")).toHaveCount(0);
});
