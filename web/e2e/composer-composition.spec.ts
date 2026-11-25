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

test("the breathing room lives at the content end, not above the input box", async ({ page }) => {
  // 内测反馈：浮框式后输入框上方又出现一层留白（composer 顶部 12px），与列表
  // 底部 24px 叠成两段——留白应全部住在滚动内容区的末尾，输入框直接贴边界。
  // 注意：滚动容器自身的 padding-bottom 在内容溢出时不计入滚动范围（Chromium
  // 行为）——但浮框式 + col flex-shrink 0 之后 col 随内容真实长高，padding 已
  // 被计入（真机实测）。末尾可见留白 = 最后一条消息的底边距（代码块 12px/
  // 纯文本 0）+ 列表底部 12px；用户要求从 46.5px 减半到 ~24px，故 spacer 整个
  // 移除、列表 padding-bottom 定 12px。
  await page.getByTestId("composer-input").fill("end gap probe");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  const s = await page.evaluate(() => {
    const list = document.querySelector(".message-list") as HTMLElement;
    const cs = getComputedStyle(list);
    const gap = document.querySelector("[data-testid=message-end-gap]");
    const last = [...document.querySelectorAll(".markdown")].pop() as HTMLElement;
    return {
      composerTop: getComputedStyle(document.querySelector(".composer") as HTMLElement).paddingTop,
      listBottom: cs.paddingBottom,
      gapPresent: !!gap,
      visibleEndGap: +(list.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom).toFixed(1),
    };
  });
  expect(s.composerTop).toBe("0px");
  expect(s.listBottom).toBe("12px");
  expect(s.gapPresent).toBe(false);
  // mock 回复以纯文本结尾（无代码块底边距）→ 可见留白 = 列表 padding 12px
  //（行高残余给 ±2px 公差）
  expect(s.visibleEndGap).toBeGreaterThanOrEqual(10);
  expect(s.visibleEndGap).toBeLessThanOrEqual(16);
});

test("the chip row is capped at ~two rows with internal scroll (safety valve)", async ({ page }) => {
  await attach(page, 10);
  const info = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=image-chips]") as HTMLElement;
    const cs = getComputedStyle(el);
    return { maxH: cs.maxHeight, overflowY: cs.overflowY, h: el.getBoundingClientRect().height };
  });
  expect(info.maxH).toBe("160px");
  expect(info.overflowY).toBe("auto");
  expect(info.h).toBeLessThanOrEqual(160);
});
