import { expect, test } from "@playwright/test";

/**
 * 内容块操作条（041/047）：
 * 1. 按钮待在块的**上方外侧**（右上角、块之外）——不再压在代码/图形上；
 * 2. 悬浮块才出现；
 * 3. 鼠标从块里往上移到按钮的途中按钮不能消失，必须能点到；
 * 4. 所有块按钮长得一样（「复制为图片」不再自成一档）。
 */

async function sendMermaid(page: import("@playwright/test").Page) {
  await page.goto("/?md=mermaid");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("draw it");
  await page.getByTestId("send-btn").click();
  // Settle the whole stream: the trailing message_update events still wipe
  // .markdown, which swallows clicks.
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  await expect(page.locator(".markdown .block-shell").first()).toBeVisible();
}

test("the action bar sits above the block, outside it", async ({ page }) => {
  await sendMermaid(page);
  const pre = page.locator(".markdown .block-shell pre").first();
  await pre.hover();
  const geo = await page.evaluate(() => {
    const pre = document.querySelector(".markdown .block-shell pre") as HTMLElement;
    const bar = document.querySelector(".markdown .block-shell > .block-actions") as HTMLElement;
    const p = pre.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return { preTop: p.top, preRight: p.right, barBottom: b.bottom, barRight: b.right, barTop: b.top };
  });
  // The bar's bottom edge is at/above the block's top edge → outside the block.
  expect(geo.barBottom).toBeLessThanOrEqual(geo.preTop + 0.5);
  // Right-aligned with the block's right edge.
  expect(geo.barRight).toBeLessThanOrEqual(geo.preRight + 1);
  expect(geo.barRight).toBeGreaterThan(geo.preRight - 40);
  // It is a real bar (not collapsed to nothing).
  expect(geo.barTop).toBeLessThan(geo.barBottom);
});

test("the bar is hidden until the block is hovered", async ({ page }) => {
  await sendMermaid(page);
  const state = await page.evaluate(() => {
    const bar = document.querySelector(".markdown .block-shell > .block-actions") as HTMLElement;
    const s = getComputedStyle(bar);
    return { opacity: Number(s.opacity), pointerEvents: s.pointerEvents };
  });
  expect(state.opacity).toBeLessThan(0.05);
  // Hidden means "not clickable" — the user cannot hit an invisible button.
  expect(state.pointerEvents).toBe("none");

  await page.locator(".markdown .block-shell pre").first().hover();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const bar = document.querySelector(".markdown .block-shell > .block-actions") as HTMLElement;
        return Number(getComputedStyle(bar).opacity);
      }),
    )
    .toBeGreaterThan(0.9);
});

test("the mouse can travel from the block onto the button and click it", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await sendMermaid(page);
  const pre = page.locator(".markdown .block-shell pre").first();
  const bar = page.locator(".markdown .block-shell > .block-actions").first();
  const btn = bar.locator(".code-copy-btn").first();
  // The bar lives ABOVE the block — scroll it into view first, otherwise the
  // button sits above the viewport and the pointer cannot reach it.
  await bar.scrollIntoViewIfNeeded();

  // A real pointer path: onto the block, then up to the button (the bar sits
  // outside the block, so the pointer crosses a gap — the bar must survive it).
  const preBox = (await pre.boundingBox())!;
  await page.mouse.move(preBox.x + preBox.width / 2, preBox.y + 30);
  const btnBox = (await btn.boundingBox())!;
  expect(btnBox.y).toBeGreaterThanOrEqual(0);
  await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2, { steps: 6 });
  // Still visible after the travel — otherwise the click would land on air.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.querySelector(".markdown .block-shell > .block-actions") as HTMLElement;
        return Number(getComputedStyle(el).opacity);
      }),
    )
    .toBeGreaterThan(0.9);
  await btn.click();
  await expect(btn).toHaveText("✓");
});

test("every block action button shares one style", async ({ page }) => {
  await sendMermaid(page);
  await page.locator(".markdown .block-shell pre").first().hover();
  const styles = await page.evaluate(() => {
    const pick = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        fontSize: s.fontSize,
        borderRadius: s.borderRadius,
        borderWidth: s.borderWidth,
        padding: s.padding,
        background: s.backgroundColor,
      };
    };
    return {
      copy: pick(".markdown .block-shell .code-copy-btn"),
      ide: pick(".markdown .block-shell .code-ide-btn"),
      image: pick(".markdown .block-shell .copy-image-btn"),
    };
  });
  expect(styles.copy).not.toBeNull();
  expect(styles.ide).not.toBeNull();
  expect(styles.image).not.toBeNull();
  // The copy-as-image button used to look like a different product entirely.
  expect(styles.image).toEqual(styles.copy);
  expect(styles.ide).toEqual(styles.copy);
});

test("a narrow graphic keeps its bar above the art, inside the column, off the text", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("draw it");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });

  const frame = page.locator(".markdown .copyable-frame").first();
  await expect(frame).toHaveCount(1);
  await frame.hover();

  const geo = await page.evaluate(() => {
    const frame = document.querySelector(".markdown .copyable-frame") as HTMLElement;
    const bar = frame.querySelector(":scope > .block-actions") as HTMLElement;
    const svg = frame.querySelector("svg") as SVGSVGElement;
    const clip = document.querySelector(".message-list") as HTMLElement;
    const b = bar.getBoundingClientRect();
    const s = svg.getBoundingClientRect();
    const c = clip.getBoundingClientRect();
    // The label line right above the graphic must stay readable.
    const prev = frame.previousElementSibling as HTMLElement | null;
    return {
      lane: frame.getAttribute("data-lane"),
      align: frame.getAttribute("data-align"),
      barLeft: b.left,
      barRight: b.right,
      barBottom: b.bottom,
      svgTop: s.top,
      clipLeft: c.left,
      clipRight: c.right,
      prevText: prev ? prev.textContent?.trim().slice(0, 20) : null,
    };
  });
  // The bar is wider than a small inline graphic → it gets its own lane.
  expect(geo.lane).toBe("1");
  // The bar sits ABOVE the graphic, outside it.
  expect(geo.barBottom).toBeLessThanOrEqual(geo.svgTop + 0.5);
  // The column clips horizontally: a bar growing past the edge loses its end
  // and the button cannot be clicked any more.
  expect(geo.barLeft).toBeGreaterThanOrEqual(geo.clipLeft - 0.5);
  expect(geo.barRight).toBeLessThanOrEqual(geo.clipRight + 0.5);
});
