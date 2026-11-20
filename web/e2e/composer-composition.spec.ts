import { expect, test, type Page } from "@playwright/test";

/**
 * Composer 的「浮框式」构成（输入区分隔竞品调研拍板）：
 * 1. composer 与消息区之间不再有分割线与条带底色——分隔完全交给 24px 留白 +
 *    输入框自身的边框（16 家竞品「双线并用」0 先例，IDE 编码面板 5/6 浮框式）；
 * 2. 图片缩略卡渲染在 `.composer-box` 边框**内部**（VS Code/Cline/ChatGPT 的
 *    通行做法：附件行是带边框容器的第一个子节点，容器长高包住一切），否则卡片
 *    悬在消息区与输入框之间的无人区；
 * 3. 图片很多时缩略卡区换行（flex-wrap 既有）并以约两行封顶、内部滚动——
 *    不给 composer 反客为主吃掉消息区的机会。
 */

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function attach(page: Page, count: number) {
  await page.setInputFiles(
    'input[type="file"]',
    Array.from({ length: count }, (_, i) => ({
      name: `pic-${i + 1}.png`,
      mimeType: "image/png",
      buffer: PNG,
    })),
  );
  await expect(page.getByTestId("image-chips")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("image chips live inside the composer box border (attachments stay grouped)", async ({ page }) => {
  await attach(page, 1);
  const inside = await page.evaluate(() => {
    const chips = document.querySelector("[data-testid=image-chips]");
    const box = document.querySelector(".composer-box");
    return !!chips && !!box && box.contains(chips);
  });
  expect(inside).toBe(true);
});

test("the composer floats: no divider line and no strip band (floating-box)", async ({ page }) => {
  const s = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".composer") as HTMLElement);
    return { borderTopWidth: cs.borderTopWidth, background: cs.backgroundColor };
  });
  expect(s.borderTopWidth).toBe("0px");
  expect(s.background).toBe("rgba(0, 0, 0, 0)");
});

test("the chip row is capped at ~two rows with internal scroll (safety valve)", async ({ page }) => {
  await attach(page, 10);
  const info = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=image-chips]") as HTMLElement;
    const cs = getComputedStyle(el);
    return { maxH: cs.maxHeight, overflowY: cs.overflowY, h: el.getBoundingClientRect().height };
  });
  expect(info.maxH).toBe("190px");
  expect(info.overflowY).toBe("auto");
  expect(info.h).toBeLessThanOrEqual(190);
});
