import { expect, test, type Page } from "@playwright/test";

/**
 * File/directory reference chips (spec 015): the IDE pushes `ide` events with
 * kind "refs" (right-click "Add Directory / Send File"), the composer shows
 * them as removable chips, and sending turns them into `@path` tokens on the
 * message's first line — no directory listings, no file contents.
 * Drag & drop is covered with a synthetic uri-list DataTransfer (the flavour
 * an IDEA project-tree drag offers); desktop file drags go through the same
 * collect/resolve pipeline.
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

test("ide refs events become chips, accumulate and dedupe", async ({ page }) => {
  await pushIde(page, {
    kind: "refs",
    files: [
      { path: "src", dir: true },
      { path: "README.md", dir: false },
    ],
  });
  const chips = page.getByTestId("ref-chips");
  await expect(chips).toBeVisible();
  await expect(chips.locator(".ref-chip")).toHaveCount(2);
  await expect(chips.locator(".ref-chip[data-dir='true']")).toHaveText(/src/);
  await expect(chips.locator(".ref-chip[data-dir='false']")).toHaveText(/README\.md/);

  // A second right-click on another directory keeps both; the repeated path
  // is a no-op.
  await pushIde(page, {
    kind: "refs",
    files: [
      { path: "src", dir: true },
      { path: "docs", dir: true },
    ],
  });
  await expect(chips.locator(".ref-chip")).toHaveCount(3);
});

test("a refs-only push never wipes the draft", async ({ page }) => {
  const input = page.getByTestId("composer-input");
  await input.fill("my draft");
  await pushIde(page, { kind: "refs", files: [{ path: "src", dir: true }] });
  await expect(page.getByTestId("ref-chips")).toBeVisible();
  await expect(input).toHaveValue("my draft");
});

test("a chip can be removed by its × button", async ({ page }) => {
  await pushIde(page, {
    kind: "refs",
    files: [
      { path: "src", dir: true },
      { path: "README.md", dir: false },
    ],
  });
  const chips = page.getByTestId("ref-chips");
  await chips.locator('button[aria-label="Remove the reference to src"]').click();
  await expect(chips.locator(".ref-chip")).toHaveCount(1);
  await expect(chips.locator(".ref-chip")).toHaveText(/README\.md/);
});

test("sending turns refs into @path tokens on the first line", async ({ page }) => {
  await pushIde(page, {
    kind: "refs",
    files: [
      { path: "src", dir: true },
      { path: "README.md", dir: false },
    ],
  });
  const input = page.getByTestId("composer-input");
  await input.fill("summarize these");
  await page.getByTestId("send-btn").click();

  await expect(page.getByTestId("item-user")).toHaveCount(1);
  const first = page.getByTestId("item-user").first();
  // Markdown renders the "\n" between the tokens and the body as a line
  // break, so textContent concatenates without whitespace.
  await expect(first).toContainText("@src @README.md");
  await expect(first).toContainText("summarize these");
  // The chips leave with the message.
  await expect(page.getByTestId("ref-chips")).toHaveCount(0);
  await expect(input).toHaveValue("");
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
  const grown = await input.evaluate((el) => el.getBoundingClientRect().height);
  expect(grown).toBeGreaterThan(singleLine * 2);

  await page.getByTestId("send-btn").click();
  const collapsed = await input.evaluate((el) => el.getBoundingClientRect().height);
  expect(collapsed).toBeLessThanOrEqual(singleLine + 2);
});

test("a project-tree drag (uri-list) becomes a project-relative chip", async ({ page }) => {
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.setData("text/uri-list", "file:///tmp/mock-project/src/store/store.ts");
    return dt;
  });
  await page.getByTestId("composer").dispatchEvent("drop", { dataTransfer });

  const chips = page.getByTestId("ref-chips");
  await expect(chips.locator(".ref-chip")).toHaveCount(1);
  // The mock bridge resolved the absolute path under /tmp/mock-project.
  await expect(chips.locator(".ref-chip")).toHaveText(/src\/store\/store\.ts/);
  await expect(chips.locator(".ref-chip[data-dir='false']")).toHaveCount(1);
});

test("a Chinese IDE localizes the chip's remove label", async ({ page }) => {
  await page.goto("/?locale=zh");
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await pushIde(page, { kind: "refs", files: [{ path: "src", dir: true }] });
  await expect(
    page.getByTestId("ref-chips").locator('button[aria-label="移除对 src 的引用"]'),
  ).toBeVisible();
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
  const chips = page.getByTestId("ref-chips");
  await expect(chips.locator(".ref-chip")).toHaveCount(1);
  await expect(chips.locator(".ref-chip")).toHaveText(/src\/store\/store\.ts/);
});

test("a folder drag keeps the directory flag from the IDE side", async ({ page }) => {
  await page.goto("/?drop=/tmp/mock-project/src/");
  await expect(page.getByTestId("composer-input")).toBeVisible();

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    // A folder drop arrives as a file item with no MIME type.
    dt.items.add(new File([], "src", { type: "" }));
    return dt;
  });
  await page.getByTestId("composer").dispatchEvent("drop", { dataTransfer });

  const chips = page.getByTestId("ref-chips");
  await expect(chips.locator(".ref-chip[data-dir='true']")).toHaveText(/src/);
});

test("dragged code lands as text, not as a bogus reference chip", async ({ page }) => {
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "const answer = 42;");
    return dt;
  });
  await page.getByTestId("composer").dispatchEvent("drop", { dataTransfer });

  await expect(page.getByTestId("composer-input")).toHaveValue("const answer = 42;");
  await expect(page.getByTestId("ref-chips")).toHaveCount(0);
});
