import { expect, test } from "@playwright/test";

/**
 * 051 — a provider that pi no longer knows must not brick the panel.
 *
 * Real machine (2026-11-25, project D:\code\fis\cmfc-fis): the project still
 * remembered `provider=ds`, but `ds` had been deleted from
 * `~/.pi/agent/models.json` a week earlier. pi refused to start
 * (`Error: Unknown provider "ds"`), so the panel showed a red exit banner —
 * and the only thing in it was "pi process closed stdout (exit code 1)".
 * The actual cause was hidden behind "查看详情", the model picker was empty
 * (it is fed by the running pi), and "重启" re-used the same stale preference,
 * so the user could not get out of it from inside the panel at all.
 *
 * Two things are pinned here: the exit headline must carry pi's own error
 * line, and the panel must say out loud that it fell back to the default
 * model.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("the exit banner headlines pi's own error line, not the shell message", async ({ page }) => {
  await page.evaluate(() => {
    const s = (
      window as unknown as {
        __piStore: { setState: (p: Record<string, unknown>) => void };
      }
    ).__piStore;
    s.setState({
      piStatus: "exited",
      exitMessage: 'Unknown provider "ds". Use --list-models to see available providers/models.',
      exitStderr: 'Error: Unknown provider "ds". Use --list-models to see available providers/models.',
    });
  });

  const headline = page.getByTestId("exit-banner-msg");
  await expect(headline).toContainText('Unknown provider "ds"');
  // The shell message is noise next to the cause — it must not be the headline.
  await expect(headline).not.toContainText("pi process closed stdout");
});

test("the panel says it fell back to the default model", async ({ page }) => {
  await page.evaluate(() => {
    const s = (
      window as unknown as {
        __piStore: { setState: (p: Record<string, unknown>) => void };
      }
    ).__piStore;
    s.setState({
      piStatus: "running",
      piNotice: { kind: "staleModel", provider: "ds", model: "deepseek-flash" },
    });
  });

  const notice = page.getByTestId("notice-banner");
  await expect(notice).toBeVisible();
  // The provider name is the actionable part: it is what the user has to fix.
  await expect(notice).toContainText("ds");
  await expect(notice).toContainText("deepseek-flash");
});

test("the fallback notice is translated for a Chinese IDE", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.evaluate(() => {
    const s = (
      window as unknown as {
        __piStore: { setState: (p: Record<string, unknown>) => void };
      }
    ).__piStore;
    s.setState({
      piStatus: "running",
      piNotice: { kind: "staleModel", provider: "ds", model: "deepseek-flash" },
    });
  });

  const notice = page.getByTestId("notice-banner");
  await expect(notice).toContainText("ds");
  await expect(notice).not.toContainText("staleModel");
});

test("no notice banner when there is nothing to report", async ({ page }) => {
  await expect(page.getByTestId("notice-banner")).toHaveCount(0);
});

test("the real pi-state event drives the headline and the notice", async ({ page }) => {
  // The path the bridge actually uses: an event → the store → the screen.
  await page.goto("/?pistate=exited");
  await expect(page.getByTestId("exit-banner-msg")).toContainText('Unknown provider "ds"');
  await expect(page.getByTestId("exit-banner-msg")).not.toContainText("pi process closed stdout");

  await page.goto("/?pistate=notice");
  const notice = page.getByTestId("notice-banner");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("ds");
  await expect(notice).toContainText("deepseek-flash");
});
