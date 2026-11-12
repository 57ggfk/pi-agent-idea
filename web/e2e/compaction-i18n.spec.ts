import { expect, test, type Page } from "@playwright/test";

/**
 * Spec 031 — compaction notices and the same family of failure notices go
 * through i18n. Before this spec the manual compact inserted a hardcoded
 * English "Context compacted: A → B tokens." regardless of the UI language,
 * and the auto-compaction events never rendered at all (pi 18.0.7 renamed
 * them to auto_compaction_*; the old compaction_* cases were dead branches).
 *
 * These tests pin the user-visible surface: Chinese under a Chinese IDE, and
 * English wording that stays verbatim what it used to be (US5), so a future
 * rewording cannot sneak past review. The auto-event reducer surface is
 * covered by store/types.test.ts (e2e cannot trigger a real auto compaction).
 */

/** The last system notice in the transcript — the one the compact just added. */
const notice = (page: Page) => page.locator('[data-testid="system-item"]').last();

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("a manual compact under zh shows a Chinese notice with grouped tokens (US1)", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("compact-btn").click();

  await expect(notice(page)).toContainText("上下文已压缩：12,000 → 3,400 tokens。");
  // The old hardcoded template must be gone, not just joined by a translation.
  await expect(notice(page)).not.toContainText("Context compacted");
});

test("a refused compact under zh shows 压缩失败 with the raw pi message (US2)", async ({ page }) => {
  await page.goto("/?locale=zh&failcmd=compact");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("compact-btn").click();

  await expect(notice(page)).toContainText("压缩失败：");
  // {{msg}} passes the pi-side text through untranslated (spec: 不翻译原始错误);
  // the mock refusal itself contains the literal "compact failed:", so the
  // prefix assertion above is the only wording pin here.
  await expect(notice(page)).toContainText("mock refusal");
});

test("an English IDE keeps the verbatim pre-031 wording (US5)", async ({ page }) => {
  await page.getByTestId("compact-btn").click();

  await expect(notice(page)).toHaveText("Context compacted: 12,000 → 3,400 tokens.");
  await expect(notice(page)).not.toContainText("⟦");
});
