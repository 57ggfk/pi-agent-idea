import { expect, test } from "@playwright/test";

/**
 * 049 代码块「渲染 ⇄ 源码」模式切换：
 * 1. ```svg / ```mermaid 默认渲染成图（源码隐藏）；
 * 2. 标题栏里多一个「源码」开关，两种模式来回切（图形与源码互斥）；
 * 3. **换行开关只在源码模式生效** —— 渲染模式下按钮禁用、点了没反应；
 * 4. 渲染不出来的块（语法错的 mermaid / 画不出的 svg）落到源码模式，
 *    模式开关置灰（不给用户一个点了没反应的按钮）。
 */

type Page = import("@playwright/test").Page;

async function sendMock(page: Page, md: string) {
  await page.goto(`/?md=${md}`);
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("draw it");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

/** The n-th code block of the reply (`.block-shell` = one fenced block). */
const block = (page: Page, n = 0) => page.locator(".markdown .block-shell").nth(n);

/** Reads the block's display mode + wrap switch state in one shot. */
async function readState(page: Page, n = 0) {
  return page.evaluate((idx) => {
    const shell = document.querySelectorAll(".markdown .block-shell")[idx] as HTMLElement;
    const code = shell.querySelector("code") as HTMLElement;
    const pre = shell.querySelector("pre") as HTMLElement;
    const modeBtn = shell.querySelector(".code-source-btn") as HTMLButtonElement | null;
    const wrapBtn = shell.querySelector(".code-wrap-btn") as HTMLButtonElement;
    const gutter = shell.querySelector(".code-gutter") as HTMLElement;
    return {
      lang: (code.className.match(/language-([\w+#-]+)/)?.[1] ?? "").toLowerCase(),
      codeHidden: getComputedStyle(code).display === "none",
      hasFigure: !!shell.querySelector(".mermaid-figure, .svg-figure"),
      modePresent: !!modeBtn,
      modePressed: modeBtn?.getAttribute("aria-pressed") ?? null,
      modeDisabled: modeBtn?.disabled ?? false,
      modeLabel: modeBtn?.textContent ?? "",
      wrapDisabled: wrapBtn.disabled,
      wrapPressed: wrapBtn.getAttribute("aria-pressed"),
      whiteSpace: getComputedStyle(pre).whiteSpace,
      gutterHidden: gutter.hidden,
      gutterNos: gutter.querySelectorAll(".code-line-no").length,
    };
  }, n);
}

test("a mermaid block starts in render mode: the diagram shows, the source hides (049 US1)", async ({ page }) => {
  await sendMock(page, "mermaid");
  // The diagram is rendered asynchronously — wait for it to land.
  await expect.poll(async () => (await readState(page)).hasFigure, { timeout: 20_000 }).toBe(true);
  const state = await readState(page);
  expect(state.lang).toBe("mermaid");
  // The diagram took the block's place.
  expect(state.codeHidden).toBe(true);
  // The mode switch is there, in the OFF state (we are looking at the render).
  expect(state.modePresent).toBe(true);
  expect(state.modePressed).toBe("false");
  expect(state.modeDisabled).toBe(false);
  expect(state.modeLabel).toBe("Source");
  // …and the wrap switch is disabled: in render mode there are no lines to wrap.
  expect(state.wrapDisabled).toBe(true);

  // The diagram must STAY: a late resolution of a concurrent request for the
  // same source (which returns null) must not tear the picture down again.
  await page.waitForTimeout(1500);
  const stable = await readState(page);
  expect(stable.hasFigure).toBe(true);
  expect(stable.codeHidden).toBe(true);
});

test("the mode switch flips between render and source (049 US2)", async ({ page }) => {
  await sendMock(page, "mermaid");
  const modeBtn = block(page).locator(".code-source-btn");
  await modeBtn.click();

  // Source mode: the source is back, the diagram is gone.
  await expect.poll(async () => (await readState(page)).codeHidden).toBe(false);
  let state = await readState(page);
  expect(state.hasFigure).toBe(false);
  expect(state.modePressed).toBe("true");
  // The wrap switch is back (the source has lines again).
  expect(state.wrapDisabled).toBe(false);
  // The line numbers come back with the source.
  expect(state.gutterHidden).toBe(false);
  expect(state.gutterNos).toBeGreaterThan(0);

  // …and back to render mode.
  await modeBtn.click();
  await expect.poll(async () => (await readState(page)).hasFigure).toBe(true);
  state = await readState(page);
  expect(state.codeHidden).toBe(true);
  expect(state.modePressed).toBe("false");
  expect(state.wrapDisabled).toBe(true);
});

test("the wrap switch only works in source mode (049 US3)", async ({ page }) => {
  await sendMock(page, "mermaid");
  const wrapBtn = block(page).locator(".code-wrap-btn");
  // Render mode: the switch is off limits.
  await expect(wrapBtn).toBeDisabled();

  // Source mode: wrapping works.
  await block(page).locator(".code-source-btn").click();
  await expect(wrapBtn).toBeEnabled();
  await wrapBtn.click();
  await expect(wrapBtn).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await readState(page)).whiteSpace).toBe("pre-wrap");

  // Back to render mode → the wrap switch is disabled again, and clicking it
  // must not change anything (the code is hidden anyway).
  await block(page).locator(".code-source-btn").click();
  await expect(wrapBtn).toBeDisabled();
  const before = await readState(page);
  await wrapBtn.click({ force: true }).catch(() => undefined);
  const after = await readState(page);
  // The click did nothing: the remembered state survives, the layout did not move.
  expect(after.wrapPressed).toBe(before.wrapPressed);
  expect(after.whiteSpace).toBe(before.whiteSpace);
  expect(after.wrapDisabled).toBe(true);
});

test("a fenced svg block switches modes too (049 US2)", async ({ page }) => {
  await sendMock(page, "svg");
  const state = await readState(page);
  expect(state.lang).toBe("svg");
  expect(state.hasFigure).toBe(true);
  expect(state.codeHidden).toBe(true);
  expect(state.modePressed).toBe("false");

  await block(page).locator(".code-source-btn").click();
  await expect.poll(async () => (await readState(page)).codeHidden).toBe(false);
  const source = await readState(page);
  expect(source.hasFigure).toBe(false);
  expect(source.modePressed).toBe("true");
  // The source is the raw SVG markup — still copyable, still openable in the IDE.
  expect(await block(page).locator("code").textContent()).toContain('<circle cx="10"');
});

test("a block that cannot render falls back to source (049 US4)", async ({ page }) => {
  await sendMock(page, "mermaid");
  // The second mermaid block of the mock reply has a syntax error → it can
  // never render → it shows its source.
  const broken = block(page, 1);
  await expect(broken.locator(".code-source-btn")).toHaveAttribute("aria-pressed", "false");
  const state = await readState(page, 1);
  expect(state.codeHidden).toBe(false);
  expect(state.hasFigure).toBe(false);
  // The switch is NOT greyed out — switching to source must always work
  // (streaming prefixes fail to render all the time).
  expect(state.modeDisabled).toBe(false);
  // The wrap switch works there (the code is on screen).
  expect(state.wrapDisabled).toBe(false);

  // Asking for the render on a block that cannot render flashes ✗ and keeps
  // the source — no silent no-op.
  await broken.locator(".code-source-btn").click();
  await expect(broken.locator(".code-source-btn")).toHaveAttribute("aria-pressed", "true");
  await broken.locator(".code-source-btn").click();
  await expect(broken.locator(".code-source-btn")).toHaveText("✗", { timeout: 3000 });
  const after = await readState(page, 1);
  expect(after.codeHidden).toBe(false);
  expect(after.hasFigure).toBe(false);
});

test("an ordinary code block has no mode switch and keeps its wrap switch (049 FR-002)", async ({ page }) => {
  await sendMock(page, "diff");
  const state = await readState(page);
  expect(state.lang).toBe("diff");
  expect(state.modePresent).toBe(false);
  expect(state.wrapDisabled).toBe(false);
});

test("the chosen mode survives the streaming rebuild (049 FR-004)", async ({ page }) => {
  await page.goto("/?md=mermaid");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("draw it");
  await page.getByTestId("send-btn").click();
  // Wait for the block to exist — the reply is still streaming.
  await expect(page.locator(".markdown .block-shell .code-source-btn").first()).toBeVisible({ timeout: 30_000 });
  // Switch to source mode mid-stream: a direct DOM click, because React
  // rebuilds the block's HTML on every delta and a pointer click could land
  // on a node that is detached a moment later.
  await page.evaluate(() => {
    const btn = document.querySelector(".markdown .block-shell .code-source-btn") as HTMLElement;
    btn.click();
  });
  // …the stream keeps rewriting that very block…
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  // …and the block is still in source mode (it lives in a map, not in the DOM).
  const state = await readState(page);
  expect(state.modePressed).toBe("true");
  expect(state.codeHidden).toBe(false);
  expect(state.hasFigure).toBe(false);
});
