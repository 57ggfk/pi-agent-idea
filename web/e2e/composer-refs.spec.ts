import { expect, test, type Page } from "@playwright/test";

/**
 * Inline reference tokens (spec 018 US1, on top of 015/016): the IDE pushes
 * `ide` events with kind "refs" (right-click "Add Directory / Send File"),
 * drops and file pastes land at the caret, and every reference is the text
 * `@path` itself — the mirror overlay paints a pill over each token. Sending
 * is the raw text; pi resolves `@` references itself.
 * Drag & drop is covered with a synthetic uri-list DataTransfer (the flavour
 * an IDEA project-tree drag offers); desktop file drags go through the same
 * collect/resolve pipeline. The 018 US3 tightening is covered too: multi-line
 * markdown pastes are text, never references.
 */

declare global {
  interface Window {
    /** Registered by the MockBridge constructor for e2e ide-event injection. */
    __piMockIde?: (data: unknown) => void;
  }
}

/** Injects an `ide` event the way the real Kotlin side does. */
async function pushIde(page: Page, data: Record<string, unknown>) {
  await page.evaluate((d) => window.__piMockIde?.(d), data);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
});

test("ide refs events become inline tokens, in order, without dedupe", async ({ page }) => {
  await pushIde(page, {
    kind: "refs",
    files: [
      { path: "src", dir: true },
      { path: "README.md", dir: false },
    ],
  });
  const input = page.getByTestId("composer-input");
  // Tokens appended at the tail, each followed by a separator space.
  await expect(input).toHaveValue("@src @README.md ");
  const tokens = page.getByTestId("ref-token");
  await expect(tokens).toHaveCount(2);
  await expect(tokens.first()).toHaveText("@src");
  await expect(tokens.last()).toHaveText("@README.md");

  // A second right-click adds another directory. References are the text
  // itself — no dedupe (018 US1): the repeated `src` is another token.
  await pushIde(page, {
    kind: "refs",
    files: [
      { path: "src", dir: true },
      { path: "docs", dir: true },
    ],
  });
  await expect(page.getByTestId("ref-token")).toHaveCount(4);
});

test("a refs-only push keeps the draft and separates itself from it", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.fill("my draft");
  await pushIde(page, { kind: "refs", files: [{ path: "src", dir: true }] });
  // A space separates the draft from the token — a glued `draft@src` would
  // not even read as a token.
  await expect(input).toHaveValue("my draft @src ");
  await expect(page.getByTestId("ref-token")).toHaveCount(1);
});

test("one Backspace after a token removes the whole token", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.fill("");
  await pushIde(page, {
    kind: "refs",
    files: [
      { path: "src", dir: true },
      { path: "README.md", dir: false },
    ],
  });
  await expect(input).toHaveValue("@src @README.md ");
  await input.press("Backspace");
  await expect(input).toHaveValue("@src ");
  await expect(page.getByTestId("ref-token")).toHaveCount(1);
  await input.press("Backspace");
  await expect(input).toHaveValue("");
});

test("clicking a token selects it, typing replaces it", async ({ page }) => {
  await pushIde(page, { kind: "refs", files: [{ path: "src", dir: true }] });
  const token = page.getByTestId("ref-token").first();
  await token.click();
  const input = page.getByTestId("composer-input");
  const [start, end] = await input.evaluate((el: HTMLTextAreaElement) => [
    el.selectionStart,
    el.selectionEnd,
  ]);
  expect(start).toBe(0);
  expect(end).toBe("@src".length);
  await input.press("x");
  await expect(input).toHaveValue("x ");
});

test("sending keeps tokens inline at their position", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.fill("summarize these");
  await pushIde(page, {
    kind: "refs",
    files: [
      { path: "src", dir: true },
      { path: "README.md", dir: false },
    ],
  });
  // Injected refs land AFTER the draft, separated by a space.
  await expect(input).toHaveValue("summarize these @src @README.md ");
  await page.getByTestId("send-btn").click();

  await expect(page.getByTestId("item-user")).toHaveCount(1);
  const first = page.getByTestId("item-user").first();
  await expect(first).toContainText("@src @README.md");
  await expect(first).toContainText("summarize these");
  // The message leaves with the text — the composer empties completely.
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("ref-token")).toHaveCount(0);
});

test("references alone are sendable", async ({ page }) => {
  await pushIde(page, { kind: "refs", files: [{ path: "README.md", dir: false }] });
  const send = page.getByTestId("send-btn");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId("item-user")).toHaveCount(1);
  await expect(page.getByTestId("item-user").first()).toContainText("@README.md");
});

test("an injected prompt ends with exactly one newline (caret on a fresh line)", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await pushIde(page, { kind: "prompt", text: "Look at `src/a.ts`. Summarize what it does." });
  await expect(input).toHaveValue("Look at `src/a.ts`. Summarize what it does.\n");
});

test("the composer grows with an injected prompt and collapses after sending", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  const singleLine = await input.evaluate((el) => el.getBoundingClientRect().height);

  await pushIde(page, {
    kind: "prompt",
    text: Array.from({ length: 12 }, (_, i) => `line ${i + 1}: some injected directory listing`).join("\n"),
  });
  await expect(input).toHaveValue(/line 12/);
  // autosize runs one rAF after React commits — poll for the height instead of
  // reading it in the same tick (the 018 mirror layer widened this window).
  await expect
    .poll(() => input.evaluate((el) => el.getBoundingClientRect().height))
    .toBeGreaterThan(singleLine * 2);

  await page.getByTestId("send-btn").click();
  await expect
    .poll(() => input.evaluate((el) => el.getBoundingClientRect().height))
    .toBeLessThanOrEqual(singleLine + 2);
});

test("a project-tree drag (uri-list) becomes a project-relative token", async ({ page }) => {
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.setData("text/uri-list", "file:///tmp/mock-project/src/store/store.ts");
    return dt;
  });
  await page.getByTestId("composer").dispatchEvent("drop", { dataTransfer });

  const input = page.getByTestId("composer-input");
  // The mock bridge resolved the absolute path under /tmp/mock-project.
  await expect(input).toHaveValue("@src/store/store.ts ");
  const token = page.getByTestId("ref-token");
  await expect(token).toHaveCount(1);
  await expect(token).toHaveAttribute("data-path", "src/store/store.ts");
});

test("a Chinese IDE still tokenizes injected refs", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await pushIde(page, { kind: "refs", files: [{ path: "src", dir: true }] });
  await expect(page.getByTestId("ref-token")).toHaveText("@src");
});

// -- spec 016: dragging files/folders out of the IDE -------------------------

test("a file drag shows the drop hint and takes the IDE's real path", async ({ page }) => {
  // `?drop=…` makes the mock's files.takeDrop answer like the Kotlin side: the
  // absolute path CEF saw, already made project-relative.
  await page.goto("/?drop=/tmp/mock-project/src/store/store.ts");
  await expect(page.getByTestId("composer-input")).toBeVisible();

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    // The page only ever learns the bare name; the path must come from the IDE.
    dt.items.add(new File(["x"], "store.ts", { type: "text/plain" }));
    return dt;
  });
  const composer = page.getByTestId("composer");
  await composer.dispatchEvent("dragenter", { dataTransfer });
  await expect(page.getByTestId("composer-drop")).toBeVisible();

  await composer.dispatchEvent("drop", { dataTransfer });
  await expect(page.getByTestId("composer-drop")).toHaveCount(0);
  const input = page.getByTestId("composer-input");
  await expect(input).toHaveValue("@src/store/store.ts ");
  await expect(page.getByTestId("ref-token")).toHaveCount(1);
});

test("a folder drag becomes a token at the caret", async ({ page }) => {
  await page.goto("/?drop=/tmp/mock-project/src/");
  await expect(page.getByTestId("composer-input")).toBeVisible();

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    // A folder drop arrives as a file item with no MIME type.
    dt.items.add(new File([], "src", { type: "" }));
    return dt;
  });
  await page.getByTestId("composer").dispatchEvent("drop", { dataTransfer });

  await expect(page.getByTestId("composer-input")).toHaveValue("@src ");
  await expect(page.getByTestId("ref-token").first()).toHaveText("@src");
});

// -- spec 016 真机修复：IDE 拖拽未必带 Files flavour -------------------------

test("a drop with no Files flavour still takes the IDE's real path", async ({ page }) => {
  await page.goto("/?drop=/tmp/mock-project/src/store/store.ts");
  await expect(page.getByTestId("composer-input")).toBeVisible();
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    // 页面只看得到裸文件名，真路径在 IDE 侧；旧实现没有 Files 就跳过 takeDrop。
    dt.setData("text/plain", "store.ts");
    return dt;
  });
  await page.getByTestId("composer").dispatchEvent("drop", { dataTransfer });
  await expect(page.getByTestId("composer-input")).toHaveValue("@src/store/store.ts ");
});

test("an IDE-pushed drop batch is not duplicated by a later HTML5 drop", async ({ page }) => {
  await pushIde(page, { kind: "refs", files: [{ path: "src", dir: true }], fromDrop: true });
  await expect(page.getByTestId("composer-input")).toHaveValue("@src ");
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "src", { type: "" }));
    return dt;
  });
  await page.getByTestId("composer").dispatchEvent("drop", { dataTransfer });
  await expect(page.getByTestId("composer-input")).toHaveValue("@src ");
  await expect(page.getByTestId("ref-token")).toHaveCount(1);
});

test("dragged code lands as text, not as a bogus reference token", async ({ page }) => {
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "const answer = 42;");
    return dt;
  });
  await page.getByTestId("composer").dispatchEvent("drop", { dataTransfer });

  await expect(page.getByTestId("composer-input")).toHaveValue("const answer = 42;");
  await expect(page.getByTestId("ref-token")).toHaveCount(0);
});

// -- spec 018 US3: the paste misfire -----------------------------------------

/** Dispatches a real ClipboardEvent with the given text/plain payload. */
async function pasteText(page: Page, text: string) {
  await page.getByTestId("composer-input").evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, text);
}

test("pasting multi-line markdown inserts text and zero tokens", async ({ page }) => {
  await pasteText(
    page,
    "# title\n./gradlew buildPlugin\nsee /usr/local/bin/pi for details\nuser@example.com",
  );

  // No token was ever inserted; a synthetic paste performs no default
  // insertion, so the draft stays empty — the point is zero refs.
  await expect(page.getByTestId("ref-token")).toHaveCount(0);
});

test("pasting a single path-looking line becomes one token at the caret", async ({ page }) => {
  await pasteText(page, "/tmp/mock-project/src/store/store.ts");

  const token = page.getByTestId("ref-token");
  await expect(token).toHaveCount(1);
  // The mock bridge relativized the absolute path.
  await expect(token).toHaveAttribute("data-path", "src/store/store.ts");
});

test("typing @path in the text paints the pill inline without breaking wrapping", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.pressSequentially("before @src/store/store.ts after");
  const token = page.getByTestId("ref-token");
  await expect(token).toHaveCount(1);
  await expect(token).toHaveAttribute("data-path", "src/store/store.ts");
  // The raw text is untouched — the pill is paint, not structure.
  await expect(input).toHaveValue("before @src/store/store.ts after");
  // The pill sits inside the input wrap (in the text flow, not a row above).
  const inside = await token.evaluate((el) => {
    const wrap = el.closest(".composer-input-wrap");
    const r = el.getBoundingClientRect();
    const w = wrap?.getBoundingClientRect();
    return !!w && r.top >= w.top && r.bottom <= w.bottom;
  });
  expect(inside).toBe(true);
});
