import { expect, test } from "@playwright/test";

/**
 * 0510 — shell hardening.
 *
 * Three defects this file pins down:
 *  1. the exit banner dumped the tail of pi's stderr straight into the
 *     headline (and said "pi exited:" in English in every locale);
 *  2. an options-menu switch that failed reverted silently — the user only
 *     saw the switch snap back;
 *  3. the queue-mode menu and the tool card's file path were `<div>`/`<span>`
 *     with mouse handlers, so the keyboard could not reach them.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("the exit banner headlines the failure and keeps stderr behind a collapsed detail", async ({ page }) => {
  await page.evaluate(() => {
    const s = (
      window as unknown as {
        __piStore: { setState: (p: Record<string, unknown>) => void };
      }
    ).__piStore;
    s.setState({
      piStatus: "exited",
      exitMessage: "pi process closed stdout (exit code 1)",
      exitStderr: "Error: boom\n    at somewhere\nstack line",
    });
  });

  const banner = page.getByTestId("exit-banner");
  await expect(banner).toBeVisible();

  // The headline carries the reason — and only the reason.
  const headline = page.getByTestId("exit-banner-msg");
  await expect(headline).toContainText("pi exited");
  await expect(headline).toContainText("exit code 1");
  await expect(headline).not.toContainText("Error: boom");
  // The reason must not be clipped: a banner that hides half of it says
  // nothing (real machine: "pi 已退出：pi process cl…").
  const clipped = await headline.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(clipped, "the exit reason is clipped instead of wrapping").toBe(false);

  // stderr is still available, but only on demand.
  const body = page.locator(".exit-details-body");
  await expect(body).toBeHidden();
  await page.getByTestId("exit-details").locator("summary").click();
  await expect(body).toBeVisible();
  await expect(body).toContainText("Error: boom");
});

test("the exit banner is translated for a Chinese IDE", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.evaluate(() => {
    const s = (
      window as unknown as {
        __piStore: { setState: (p: Record<string, unknown>) => void };
      }
    ).__piStore;
    s.setState({ piStatus: "exited", exitMessage: "进程退出", exitStderr: "" });
  });

  await expect(page.getByTestId("exit-banner-msg")).toContainText("pi 已退出");
  await expect(page.getByTestId("restart-btn")).toHaveText("重启");
  // No English left in the banner.
  await expect(page.getByTestId("exit-banner")).not.toContainText("pi exited");
});

test("a failed options switch is reported in the popover, not swallowed", async ({ page }) => {
  await page.getByTestId("options-btn").click();
  await expect(page.getByTestId("options-menu")).toBeVisible();

  await page.evaluate(() => {
    const s = (
      window as unknown as {
        __piStore: { setState: (p: Record<string, unknown>) => void };
      }
    ).__piStore;
    s.setState({ settingsError: "Could not apply this setting: extension not loaded" });
  });

  const error = page.getByTestId("options-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("extension not loaded");
});

test("the queue-mode menu is reachable with the keyboard", async ({ page }) => {
  await page.getByTestId("composer-input").fill("long task");
  await page.getByTestId("send-btn").click();
  await page.waitForSelector('[data-testid="abort-btn"]', { timeout: 15_000 });

  await page.getByTestId("send-mode-caret").click();
  const item = page.getByTestId("send-mode-followUp");
  await expect(item).toBeVisible();
  // A real button — a <div onMouseDown> cannot be activated with Enter.
  await expect(item).toHaveJSProperty("tagName", "BUTTON");

  await item.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("send-mode-menu")).toBeHidden();
  // The choice took effect: the send button announces the active mode.
  await expect(page.getByTestId("send-btn")).toHaveAttribute("title", /Follow-up/);
});

test("the tool card file path is a real button", async ({ page }) => {
  await page.getByTestId("composer-input").fill("edit something");
  await page.getByTestId("send-btn").click();
  const editCard = page.locator(".tool-card", { has: page.locator(".tool-name", { hasText: "edit" }) });
  await expect(editCard).toBeVisible({ timeout: 30_000 });

  const fileLink = editCard.locator(".tool-file-link");
  await expect(fileLink).toBeVisible();
  await expect(fileLink).toContainText("src/main.tsx");
  await expect(fileLink).toHaveJSProperty("tagName", "BUTTON");
  await expect(fileLink).toHaveAttribute("type", "button");
});

test("a file link the IDE refuses says so instead of doing nothing", async ({ page }) => {
  await page.goto("/?openFile=fail");
  await page.getByTestId("composer-input").fill("edit something");
  await page.getByTestId("send-btn").click();
  const editCard = page.locator(".tool-card", { has: page.locator(".tool-name", { hasText: "edit" }) });
  await expect(editCard).toBeVisible({ timeout: 30_000 });

  // The IDE refused the path: the button has to say so, or the click looks
  // like it worked (the store used to swallow the failure).
  const fileLink = editCard.locator(".tool-file-link");
  await fileLink.click();
  await expect(fileLink).toHaveText("✗");
  // …and it recovers: the path is back.
  await expect(fileLink).toContainText("src/main.tsx", { timeout: 3000 });
});

test("the transcript can be focused so the keyboard can scroll it", async ({ page }) => {
  await expect(page.getByTestId("message-list")).toHaveAttribute("tabindex", "0");
});