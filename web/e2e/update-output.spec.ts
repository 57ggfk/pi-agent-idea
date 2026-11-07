import { test, expect, type Page } from "@playwright/test";

/**
 * Update-output banners (011 US5, task T022). The mock's `?update=` knob
 * serves the text the Kotlin pipeline (drainThread byte decode →
 * CliText.sanitizeCliOutput → safeTruncate) produces on a Chinese Windows
 * host — the frontend must display it verbatim: no added artifacts, no key
 * names, and specifically none of `\uFFFD` / `Ã` / ANSI escapes anywhere.
 */

async function openManage(page: Page, query: string) {
  await page.goto(query ? `/?${query}` : "/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("tab-manage").click();
  await expect(page.getByTestId("manage-view")).toBeVisible();
}

test("successful update shows the readable Chinese result verbatim", async ({ page }) => {
  await openManage(page, "update=garbled");

  await page.getByTestId("pi-update").click();
  const banner = page.getByTestId("env-update-result");
  await expect(banner).toContainText("安装完成 → pi 1.5.0-mock", { timeout: 15_000 });
  await expect(banner).toContainText("D:\\软件\\nodejs 显示正常");

  const text = (await banner.textContent()) ?? "";
  expect(text).not.toContain("\uFFFD");
  expect(text).not.toContain("Ã");
  expect(text).not.toContain("\u001B[");
  expect(text).not.toContain("?");
});

test("failed update surfaces the npm Chinese warning in the fail banner", async ({ page }) => {
  await openManage(page, "update=failgarbled");

  await page.getByTestId("pi-update").click();
  const banner = page.getByTestId("env-update-result");
  await expect(banner).toContainText("npm error 权限不足", { timeout: 15_000 });
  await expect(banner).toContainText("已跳过可选依赖");

  const text = (await banner.textContent()) ?? "";
  expect(text).not.toContain("\uFFFD");
  expect(text).not.toContain("Ã");
  expect(text).not.toContain("\u001B[");
  // failure keeps the ✗ marker and does not flip to success
  await expect(banner).toContainText("✗");
});
