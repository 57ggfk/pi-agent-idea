import { expect, test } from "@playwright/test";

/**
 * First-run setup card (spec: guided install).
 *
 * The card is the only place a user without pi gets to decide how pi is
 * installed, and the registry choice is the part that breaks on an intranet:
 * pinning registry.npmjs.org overrides a working `.npmrc` and turns "install"
 * into a hang. These tests drive the real UI through the mock bridge, which
 * echoes the exact argv the backend would run, so "no --registry flag" is an
 * assertion and not a comment.
 */

test("#1 npm's own registry is the default and passes no --registry", async ({ page }) => {
  await page.goto("/?setup=missing&npmregistry=https://registry.corp.example.com/&install=fail");

  const card = page.getByTestId("setup-card");
  await expect(card).toBeVisible();

  // The default option is preselected and names the URL npm would actually use,
  // so the choice is concrete rather than "whatever npm does".
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
  // Nothing to install until a URL is actually there.
  await expect(page.getByTestId("setup-install")).toBeDisabled();

  await input.fill("http://nexus.corp.local:8081/repository/npm-group");
  await expect(page.getByTestId("setup-install")).toBeEnabled();
  await page.getByTestId("setup-install").click();

  await expect(page.getByTestId("setup-log")).toContainText(
    "--registry=http://nexus.corp.local:8081/repository/npm-group",
  );
});

test("#4 a failed install keeps the card and says why", async ({ page }) => {
  await page.goto("/?setup=missing&install=fail");

  await page.getByTestId("setup-install").click();
  await expect(page.getByTestId("setup-error")).toContainText("registry was unreachable");
  // Both routes stay available after a failure.
  await expect(page.getByTestId("setup-path-input")).toBeVisible();
  await expect(page.getByTestId("setup-install")).toBeEnabled();
});

test("#5 a successful install dismisses the card", async ({ page }) => {
  await page.goto("/?setup=missing");

  await expect(page.getByTestId("setup-card")).toBeVisible();
  await page.getByTestId("setup-install").click();
  await expect(page.getByTestId("setup-card")).toHaveCount(0);
});

test("#6 without node there is no install button, only a link and the manual path", async ({
  page,
}) => {
  await page.goto("/?setup=nonode");

  await expect(page.getByTestId("setup-node-warning")).toBeVisible();
  await expect(page.getByTestId("setup-no-npm")).toBeVisible();
  await expect(page.getByTestId("setup-install")).toHaveCount(0);
  await expect(page.getByTestId("setup-path-input")).toBeVisible();
});

test("#7 an install can run indefinitely and be stopped by hand", async ({ page }) => {
  // `?install=hang`: npm never returns on its own, so only the Stop button can
  // end it. This is what an install on a slow mirror looks like from the UI.
  await page.goto("/?setup=missing&install=hang");

  await page.getByTestId("setup-install").click();
  await expect(page.getByTestId("setup-cancel")).toBeVisible();
  // The counter proves the wait is alive, not frozen.
  await expect(page.getByTestId("setup-install")).toContainText(/Installing… \d+s/);

  await page.getByTestId("setup-cancel").click();
  await expect(page.getByTestId("setup-notice")).toContainText("Install stopped");
  // Back to a usable state: no Stop button, install offered again.
  await expect(page.getByTestId("setup-cancel")).toHaveCount(0);
  await expect(page.getByTestId("setup-install")).toBeEnabled();
  await expect(page.getByTestId("setup-card")).toBeVisible();
});
