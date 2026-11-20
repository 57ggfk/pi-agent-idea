import { expect, test } from "@playwright/test";

/**
 * 048 代码块标题栏 / 换行开关 / 行号：
 * 1. 标题栏左侧是语言类型，右侧是操作按钮；
 * 2. 换行开关默认关闭（代码不换行，横向滚动），可开可关，流式重建后状态还在；
 * 3. 行号与代码行一一对齐，且框选代码时行号既不被选中、也不进剪贴板。
 */

async function sendDiffReply(page: import("@playwright/test").Page) {
  await page.goto("/?md=diff");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("apply it");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  await expect(page.locator(".markdown .block-shell .block-header").first()).toBeVisible();
}

/** The first code block's shell (the ```diff block of the mock reply). */
const firstShell = (page: import("@playwright/test").Page) => page.locator(".markdown .block-shell").first();

test("the header names the block's language (048 FR-001)", async ({ page }) => {
  await sendDiffReply(page);
  await expect(firstShell(page).locator(".block-lang")).toHaveText("Diff");
  // A fence without a language falls back to a neutral label.
  const labels = await page.locator(".markdown .block-shell .block-lang").allTextContents();
  expect(labels.every((l) => l.trim().length > 0)).toBe(true);
});

test("the code does not wrap by default and the toggle is off (048 FR-003)", async ({ page }) => {
  await sendDiffReply(page);
  const state = await page.evaluate(() => {
    const shell = document.querySelector(".markdown .block-shell") as HTMLElement;
    const pre = shell.querySelector("pre") as HTMLElement;
    const btn = shell.querySelector(".code-wrap-btn") as HTMLElement;
    return {
      whiteSpace: getComputedStyle(pre).whiteSpace,
      overflowX: getComputedStyle(pre).overflowX,
      pressed: btn.getAttribute("aria-pressed"),
      on: btn.classList.contains("is-on"),
      label: btn.textContent,
    };
  });
  expect(state.whiteSpace).toBe("pre");
  expect(state.overflowX).toBe("auto");
  expect(state.pressed).toBe("false");
  expect(state.on).toBe(false);
  expect(state.label).toBe("Wrap");
});

test("the wrap toggle turns wrapping on and off again (048 FR-003)", async ({ page }) => {
  await sendDiffReply(page);
  const shell = firstShell(page);
  const btn = shell.locator(".code-wrap-btn");
  const pre = shell.locator("pre");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => pre.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");
  // The pressed state is visible, not just semantic.
  await expect.poll(() => btn.evaluate((el) => el.classList.contains("is-on"))).toBe(true);
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => pre.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre");
});

test("the wrap state survives the streaming rebuild (048 FR-003/FR-007)", async ({ page }) => {
  await page.goto("/?md=diff");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("apply it");
  await page.getByTestId("send-btn").click();
  // Wait for the block to exist — the reply is still streaming.
  await expect(page.locator(".markdown .block-shell .code-wrap-btn").first()).toBeVisible({ timeout: 30_000 });
  // Toggle it ON with a direct DOM click: React rebuilds the block's HTML on
  // every streaming delta, so a synthetic pointer click could land on a node
  // that is detached a moment later.
  await page.evaluate(() => {
    const btn = document.querySelector(".markdown .block-shell .code-wrap-btn") as HTMLElement;
    btn.click();
  });
  // …the stream keeps rewriting that very block…
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  // …and the state is still ON afterwards (it lives in a map, not in the DOM).
  const btn = page.locator(".markdown .block-shell .code-wrap-btn").first();
  await expect.poll(async () => (await btn.getAttribute("aria-pressed")) ?? "").toBe("true");
  await expect
    .poll(() => page.locator(".markdown .block-shell pre").first().evaluate((el) => getComputedStyle(el).whiteSpace))
    .toBe("pre-wrap");
});

test("the code block shows line numbers aligned with its code lines (048 FR-004)", async ({ page }) => {
  await sendDiffReply(page);
  const info = await page.evaluate(() => {
    const shell = document.querySelector(".markdown .block-shell") as HTMLElement;
    const gutter = shell.querySelector(".code-gutter") as HTMLElement;
    const pre = shell.querySelector("pre") as HTMLElement;
    const code = shell.querySelector("code") as HTMLElement;
    const nos = Array.from(gutter.querySelectorAll(".code-line-no")) as HTMLElement[];
    const lines = (code.textContent ?? "").replace(/\n$/, "").split("\n");
    // The code's inline boxes, grouped per visual line.
    const tops = Array.from(new Set(Array.from(code.getClientRects()).map((r) => Math.round(r.top * 10) / 10))).sort(
      (a, b) => a - b,
    );
    const offsets = tops.map((t, i) => nos[i]?.getBoundingClientRect().top - t);
    return {
      // The gutter is a SIBLING of the pre (the pre scrolls horizontally and
      // would clip a gutter inside it).
      gutterOutsidePre: gutter.parentElement === shell && pre.parentElement === shell,
      count: nos.length,
      expected: lines.length,
      labels: nos.map((n) => n.textContent),
      userSelect: getComputedStyle(gutter).userSelect,
      ariaHidden: gutter.getAttribute("aria-hidden"),
      offsets,
    };
  });
  expect(info.gutterOutsidePre).toBe(true);
  expect(info.count).toBe(info.expected);
  expect(info.labels).toEqual(["1", "2", "3", "4", "5", "6"]);
  // Not selectable → a mouse selection can never pick the numbers up.
  expect(info.userSelect).toBe("none");
  expect(info.ariaHidden).toBe("true");
  // Every number sits on its own code line: the offset to the line's inline
  // box is the same for all lines (the half-leading) and small.
  const offsets = info.offsets as number[];
  expect(offsets.length).toBe(info.count);
  expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(0.6);
  expect(Math.abs(offsets[0])).toBeLessThan(4);
});

test("the line numbers sit next to their code, not glued to the block edge (049)", async ({ page }) => {
  await sendDiffReply(page);
  const geo = await page.evaluate(() => {
    const shell = document.querySelector(".markdown .block-shell") as HTMLElement;
    const gutter = shell.querySelector(".code-gutter") as HTMLElement;
    const code = shell.querySelector("code") as HTMLElement;
    const nos = Array.from(gutter.querySelectorAll(".code-line-no")) as HTMLElement[];
    // The widest number (two digits here) is the one that touches the edges.
    const widest = nos.reduce((a, b) => (b.getBoundingClientRect().width > a.getBoundingClientRect().width ? b : a));
    // The code's first character — where the eye expects the number to belong.
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode();
    let textLeft = 0;
    if (first) {
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(first, 1);
      textLeft = range.getBoundingClientRect().left;
    }
    const g = gutter.getBoundingClientRect();
    const w = widest.getBoundingClientRect();
    return {
      gapFromBlockEdge: w.left - g.left,
      gapToCode: textLeft - w.right,
      gutterPadLeft: getComputedStyle(gutter).paddingLeft,
    };
  });
  // The numbers must not be glued to the block's left border …
  expect(geo.gapFromBlockEdge).toBeGreaterThanOrEqual(4);
  // … and they must stay close to the code they belong to.
  expect(geo.gapToCode).toBeLessThanOrEqual(16);
  expect(geo.gutterPadLeft).toBe("8px");
});

test("a long line cannot push the line numbers onto their own row (048 FR-004)", async ({ page }) => {
  // 048 真机缺陷（r57）：壳是 flex-wrap，pre 的 basis 是 auto（= max-content），
  // 代码最长行一超过面板宽，pre 就被 wrap 到行号槽下面自己一行 —— 行号和代码分家。
  // 真机面板只有 450px；e2e 默认 1280px 复现不了，必须收窄视口再断言。
  await page.setViewportSize({ width: 460, height: 800 });
  await page.goto("/?md=longline");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show it");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  const geo = await page.evaluate(() => {
    const shell = document.querySelector(".markdown .block-shell") as HTMLElement;
    const gutter = shell.querySelector(".code-gutter") as HTMLElement;
    const pre = shell.querySelector("pre") as HTMLElement;
    const g = gutter.getBoundingClientRect();
    const p = pre.getBoundingClientRect();
    return {
      sideBySide: Math.abs(g.top - p.top) < 4,
      preStartsAfterGutter: p.left >= g.right - 1,
      longestLineOverflows: pre.scrollWidth > pre.clientWidth,
      gutterHidden: gutter.hidden,
    };
  });
  expect(geo.gutterHidden).toBe(false);
  expect(geo.sideBySide).toBe(true);
  expect(geo.preStartsAfterGutter).toBe(true);
  expect(geo.longestLineOverflows).toBe(true);
});

test("selecting the code does not drag the line numbers along (048 FR-004)", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await sendDiffReply(page);
  const code = page.locator(".markdown .block-shell code").first();
  // The block may sit below the fold — a drag to off-screen coordinates
  // would select the whole page instead of the code.
  await code.scrollIntoViewIfNeeded();
  const box = (await code.boundingBox())!;
  // A real mouse drag across the whole code block.
  await page.mouse.move(box.x + 2, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 4, { steps: 10 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain("context stays");
  // No line-number column came along.
  expect(selected).not.toMatch(/^\s*1\s/);
  expect(selected.trim().split("\n")).toHaveLength(6);
  // …and the clipboard carries the code only.
  await page.keyboard.press("ControlOrMeta+C");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("context stays");
  expect(clip.trim().split("\n")).toHaveLength(6);
  expect(clip).not.toMatch(/^\s*1\s/);

  // A whole-document selection (the way a user copies everything) must not
  // sweep the line numbers in either: the gutter is `user-select: none`.
  await page.locator(".markdown p").first().click();
  await page.keyboard.press("ControlOrMeta+A");
  const all = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(all).toContain("--- a/src/main.tsx");
  expect(all).not.toMatch(/\d\n--- a\/src\/main\.tsx/);
});

test("a rendered graphic block hides its line numbers (048 FR-004)", async ({ page }) => {
  await page.goto("/?md=mermaid");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("draw it");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
  // The mermaid block's source is hidden (the diagram took its place) → the
  // gutter of that block must be hidden too, or it would number nothing.
  const state = await page.evaluate(() => {
    const shell = document.querySelector(".markdown .block-shell") as HTMLElement;
    const gutter = shell.querySelector(".code-gutter") as HTMLElement;
    const code = shell.querySelector("code") as HTMLElement;
    return {
      gutterHidden: gutter.hidden,
      gutterNos: gutter.querySelectorAll(".code-line-no").length,
      codeHidden: getComputedStyle(code).display === "none",
    };
  });
  expect(state.codeHidden).toBe(true);
  expect(state.gutterHidden).toBe(true);
  expect(state.gutterNos).toBe(0);
});
