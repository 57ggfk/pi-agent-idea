import { expect, test } from "@playwright/test";

/**
 * 浮框式 + 异步渲染内容的滚动跟随（022/029 的滚动机器补强）：
 * 图片加载、SVG/Mermaid 挂载等会让内容在 message_end 之后、**不经 React
 * re-render** 地长高——pinned 视图必须跟随（ResizeObserver），否则切进富内容
 * 会话后落点悬在半空且跳底按钮被 stale pinned 吃掉（真机复现：切进「终端中
 * 渲染 SVG 围栏代码块」会话后落点距底 120px 且按钮不出现）。
 */

async function sendMessage(page: import("@playwright/test").Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

/** 等到滚动几何连续两次采样一致（排掉 mock 流与任何 post-message re-render）。 */
async function settleGeometry(page: import("@playwright/test").Page) {
  const sample = () =>
    page.evaluate(() => {
      const ml = document.querySelector(".message-list") as HTMLElement;
      return `${ml.scrollHeight}@${ml.scrollTop}`;
    });
  await page.waitForTimeout(600);
  const a = await sample();
  await page.waitForTimeout(600);
  const b = await sample();
  expect(a).toBe(b);
}

const bottomDist = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const ml = document.querySelector(".message-list") as HTMLElement;
    return +(ml.scrollHeight - ml.scrollTop - ml.clientHeight).toFixed(1);
  });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("pinned transcript follows late content growth (async mounts)", async ({ page }) => {
  // 夹具要先溢出：message-col 有 min-height 100% 地板，短会话里内容长高
  // 不改变 col 尺寸，ResizeObserver 合理地不触发；真实用户会话（45 条）都在
  // 地板之上，这里发 3 条保证溢出后再测生长跟随。
  await sendMessage(page, "scroll follow probe 1");
  await sendMessage(page, "scroll follow probe 2");
  await sendMessage(page, "scroll follow probe 3");
  await settleGeometry(page);
  await expect.poll(() => bottomDist(page), { timeout: 5_000 }).toBeLessThanOrEqual(4);

  // 在最后一条消息内部注入 300px 生长——不经 React re-render（模拟 img/SVG
  // 晚加载：DOM 长高但没有任何 effect 重跑）。
  await page.evaluate(() => {
    const last = [...document.querySelectorAll(".markdown")].pop() as HTMLElement;
    const grown = document.createElement("div");
    grown.id = "late-growth";
    grown.style.height = "300px";
    last.appendChild(grown);
  });
  await page.waitForTimeout(500);
  // pinned 视图必须跟到底（ResizeObserver 跟随）
  expect(await bottomDist(page)).toBeLessThanOrEqual(4);
});

test("unpinned transcript keeps the jump button when late content grows", async ({ page }) => {
  await sendMessage(page, "scroll follow unpinned probe 1");
  await sendMessage(page, "scroll follow unpinned probe 2");
  await sendMessage(page, "scroll follow unpinned probe 3");
  await settleGeometry(page);
  await expect.poll(() => bottomDist(page), { timeout: 5_000 }).toBeLessThanOrEqual(4);

  // 向上滚一段（解除 pinned），跳底按钮出现
  await page.evaluate(() => {
    const ml = document.querySelector(".message-list") as HTMLElement;
    ml.scrollTop = Math.max(0, ml.scrollTop - 300);
  });
  await expect(page.getByTestId("jump-bottom")).toBeVisible();

  // 内容在下方再长高 → 按钮必须保持出现
  await page.evaluate(() => {
    const last = [...document.querySelectorAll(".markdown")].pop() as HTMLElement;
    const grown = document.createElement("div");
    grown.style.height = "300px";
    last.appendChild(grown);
  });
  await page.waitForTimeout(500);
  await expect(page.getByTestId("jump-bottom")).toBeVisible();
});
