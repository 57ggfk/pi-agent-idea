import { expect, test, type Page } from "@playwright/test";

// ?dialog=select|input|editor makes the mock ask a non-confirm question between
// tool calls, the way a pi extension does through ctx.ui.select/input/editor.
// The answer (or the cancellation) is echoed into the transcript, so these
// specs check the whole round trip and not just that a card rendered.
async function send(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
}

test("a select question offers pi's options and sends the chosen one", async ({ page }) => {
  await page.goto("/?dialog=select");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await send(page, "which tier?");

  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-method", "select");
  await expect(page.getByTestId("approval-option")).toHaveCount(3);

  await page.getByTestId("approval-option").nth(1).click();
  await expect(page.getByTestId("item-assistant").filter({ hasText: "dialog answer: Balanced" }).first()).toBeVisible({
    timeout: 15000,
  });
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 15000 });
});

test("a select question can be cancelled without an answer", async ({ page }) => {
  await page.goto("/?dialog=select");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await send(page, "which tier?");

  await expect(page.getByTestId("approval-card")).toBeVisible();
  await page.getByTestId("approval-cancel").click();
  await expect(page.getByTestId("item-assistant").filter({ hasText: "dialog answer: (cancelled)" }).first()).toBeVisible({
    timeout: 15000,
  });
});

test("a free-form question submits the typed text, never an empty value", async ({ page }) => {
  await page.goto("/?dialog=input");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await send(page, "name it");

  const field = page.getByTestId("approval-input");
  await expect(field).toBeVisible();
  // 空值时提交按钮必须禁用，否则 pi 会收到一个空答案
  await expect(page.getByTestId("approval-submit")).toBeDisabled();

  await field.fill("release-notes");
  await page.getByTestId("approval-submit").click();
  await expect(page.getByTestId("item-assistant").filter({ hasText: "dialog answer: release-notes" }).first()).toBeVisible({
    timeout: 15000,
  });
});

test("an editor question starts from pi's prefill and returns the edited text", async ({ page }) => {
  await page.goto("/?dialog=editor");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await send(page, "edit the notes");

  const editor = page.getByTestId("approval-editor");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue("line one\nline two");

  await editor.fill("rewritten");
  await page.getByTestId("approval-submit").click();
  await expect(page.getByTestId("item-assistant").filter({ hasText: "dialog answer: rewritten" }).first()).toBeVisible({
    timeout: 15000,
  });
});

// pi 的 RPC 没有多选：扩展把编号选项写进 input 的标题，插件把那些行抽成可点
// 条目，点选只是往同一个输入框里写编号——提交的仍是框里的原文。
test("a numbered multi-select question lists its options and fills the numbers", async ({ page }) => {
  await page.goto("/?dialog=multi");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await send(page, "which ones first?");

  await expect(page.getByTestId("approval-card")).toBeVisible();
  await expect(page.getByTestId("approval-pick")).toHaveCount(3);
  // 选项已从正文抽走，不再与条目重复
  const title = page.getByTestId("approval-title");
  await expect(title).toContainText("你想先盖哪几个");
  await expect(title).not.toContainText("2. 唯一索引冲突");
  await expect(page.getByTestId("approval-hint")).toBeVisible();

  await page.getByTestId("approval-pick").nth(0).click();
  await page.getByTestId("approval-pick").nth(2).click();
  await expect(page.getByTestId("approval-input")).toHaveValue("1,3");

  // 再点一次取消选择，顺序按编号排
  await page.getByTestId("approval-pick").nth(2).click();
  await expect(page.getByTestId("approval-input")).toHaveValue("1");
  await page.getByTestId("approval-pick").nth(2).click();

  await page.getByTestId("approval-submit").click();
  await expect(page.getByTestId("item-assistant").filter({ hasText: "dialog answer: 1,3" }).first()).toBeVisible({
    timeout: 15000,
  });
});

test("a picked option plus custom text are sent as one string", async ({ page }) => {
  await page.goto("/?dialog=multi");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await send(page, "which ones first?");

  await page.getByTestId("approval-pick").nth(1).click();
  await page.getByTestId("approval-input").fill("2; 再加个灰度开关");
  await page.getByTestId("approval-submit").click();
  await expect(
    page.getByTestId("item-assistant").filter({ hasText: "dialog answer: 2; 再加个灰度开关" }).first(),
  ).toBeVisible({ timeout: 15000 });
});
