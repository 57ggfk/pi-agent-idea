import { expect, test } from "@playwright/test";

/**
 * 内容块操作条（041/047/060）：
 * 1. 操作按钮常驻在代码块的**标题栏**里（左侧语言类型、右侧按钮）——
 *    不再是「悬浮才出现在块外上方」；
 * 2. 标题栏一直可见可点（不必先悬浮）；
 * 3. 所有块按钮长得一样（「复制为图片」不再自成一档）；
 * 4. 行内图形（不是代码块、没有标题栏可用）仍用悬浮条。
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

test("the action buttons live in the block's header bar and are always visible", async ({ page }) => {
  await sendMermaid(page);
  // The copy-as-image entry only exists once the diagram has been painted —
  // it arrives later than the other buttons, so wait for it before reading
  // the bar's order.
  await expect(page.locator(".markdown .block-shell .copy-image-btn").first()).toBeVisible({ timeout: 30_000 });
  const state = await page.evaluate(() => {
    const shell = document.querySelector(".markdown .block-shell") as HTMLElement;
    const header = shell.querySelector(".block-header") as HTMLElement;
    const lang = header.querySelector(".block-lang") as HTMLElement;
    const actions = header.querySelector(".block-actions") as HTMLElement;
    const pre = shell.querySelector("pre") as HTMLElement;
    const s = getComputedStyle(actions);
    const box = (el: Element) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, left: b.left, right: b.right, bottom: b.bottom };
    };
    const imgBtn = actions.querySelector(".copy-image-btn") as HTMLElement | null;
    const copyBtn = actions.querySelector(".code-copy-btn") as HTMLElement | null;
    return {
      opacity: Number(s.opacity),
      pointerEvents: s.pointerEvents,
      position: s.position,
      lang: lang.textContent,
      langBox: box(lang),
      actionsBox: box(actions),
      headerBox: box(header),
      preBox: box(pre),
      buttons: Array.from(actions.querySelectorAll("button")).map((b) => b.textContent),
      // 061: 「复制为图片」在操作栏的最左——它比其它按钮晚到（图形画出来
      // 才有），append 会掉到最右边，所以是插到最前的。
      imgFirst: !!imgBtn && actions.firstElementChild === imgBtn,
      imgLeftOfCopy:
        !!imgBtn && !!copyBtn && imgBtn.getBoundingClientRect().left < copyBtn.getBoundingClientRect().left,
    };
  });
  // Always visible — the bar is part of the block now, not a hover overlay.
  expect(state.opacity).toBeGreaterThan(0.9);
  expect(state.pointerEvents).toBe("auto");
  expect(state.position).toBe("static");
  // The language label is on the LEFT, the buttons on the RIGHT.
  expect(state.langBox.left).toBeLessThan(state.actionsBox.left);
  expect(state.actionsBox.right).toBeLessThanOrEqual(state.headerBox.right + 1);
  // The header sits above the code body, inside the block's frame.
  expect(state.headerBox.bottom).toBeLessThanOrEqual(state.preBox.top + 0.5);
  expect(state.buttons).toContain("Copy");
  expect(state.buttons).toContain("Open in IDE");
  // 「复制为图片」在最左，且确实在「复制」按钮左边。
  expect(state.imgFirst).toBe(true);
  expect(state.imgLeftOfCopy).toBe(true);
});

test("the buttons are clickable without hovering the block first", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await sendMermaid(page);
  const btn = page.locator(".markdown .block-shell .code-copy-btn").first();
  await expect(btn).toBeVisible();
  // No hover, no scroll: the header button is right there.
  await btn.click();
  await expect(btn).toHaveText("✓");
});

test("every block action button shares one style", async ({ page }) => {
  await sendMermaid(page);
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
      wrap: pick(".markdown .block-shell .code-wrap-btn"),
    };
  });
  expect(styles.copy).not.toBeNull();
  expect(styles.ide).not.toBeNull();
  expect(styles.image).not.toBeNull();
  expect(styles.wrap).not.toBeNull();
  // The copy-as-image button used to look like a different product entirely.
  expect(styles.image).toEqual(styles.copy);
  expect(styles.ide).toEqual(styles.copy);
  expect(styles.wrap).toEqual(styles.copy);
});

test("a narrow graphic keeps its bar above the art, inside the column, off the text", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("draw it");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });

  // An inline graphic has no code block → no header bar → it keeps the hover
  // bar (a permanently visible bar over an inline icon would cover the text).
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
