import { expect, test } from "@playwright/test";

/**
 * Markdown format extensions, "easy" tier (038): ```diff highlighting and
 * GFM footnotes, both rendered through the existing marked + highlight.js +
 * DOMPurify pipeline. The mock reply comes from `?md=diff`.
 */

test("```diff blocks highlight added and removed lines (038 US1)", async ({ page }) => {
  await page.goto("/?md=diff");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("apply it");
  await page.getByTestId("send-btn").click();

  const diffCode = page.locator(".markdown pre code.language-diff");
  await expect(diffCode).toHaveCount(1, { timeout: 30_000 });

  // Added / removed lines carry the hljs diff token classes.
  await expect(diffCode.locator(".hljs-addition")).toHaveText("+console.log(\"new\");");
  await expect(diffCode.locator(".hljs-deletion")).toHaveText("-console.log(\"old\");");
  // Hunk markers are dimmed, added/removed lines are colored (not the plain text color).
  await expect(diffCode.locator(".hljs-meta")).toContainText("@@");
  const colors = await page.evaluate(() => {
    const get = (sel: string) => {
      const el = document.querySelector(`.markdown pre code.language-diff ${sel}`);
      return el ? getComputedStyle(el).color : "";
    };
    return { add: get(".hljs-addition"), del: get(".hljs-deletion") };
  });
  expect(colors.add).toBeTruthy();
  expect(colors.add).not.toBe(colors.del);
});

test("GFM footnotes render sup refs, a footnotes section and an in-page jump (038 US2)", async ({ page }) => {
  await page.goto("/?md=diff");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("apply it");
  await page.getByTestId("send-btn").click();

  const body = page.locator(".markdown").last();
  await expect(body).toContainText("Applied the change", { timeout: 30_000 });

  // Sup refs + collected definitions, no raw markers.
  const supRef = page.locator(".markdown sup a[data-footnote-ref]").first();
  await expect(supRef).toHaveAttribute("href", "#footnote-1");
  const section = page.locator(".markdown section.footnotes");
  await expect(section).toContainText("The change record.");
  await expect(section).toContainText("Follow-up notes.");
  // Footnote text must not leak raw `[^n]` anywhere.
  const raw = await page.evaluate(() => (document.querySelector(".markdown")?.textContent ?? "").includes("[^"));
  expect(raw).toBe(false);
  // Hash links must stay in-page (no target=_blank; a blank popup in the IDE
  // host would open a second window).
  const target = await supRef.getAttribute("target");
  expect(target).toBeNull();
  // The sr-only English label stays invisible.
  const labelVisible = await page.evaluate(() => {
    const h = document.querySelector(".markdown .footnotes .sr-only");
    if (!h) return "missing";
    const s = getComputedStyle(h);
    return s.display === "none" || (Number(s.height.replace("px", "")) <= 1 && s.overflow === "hidden") ? "hidden" : "visible";
  });
  expect(labelVisible).toBe("hidden");

  // Clicking the sup ref jumps to the definition (same document).
  await supRef.click();
  await expect(page.locator(".markdown li#footnote-1")).toBeInViewport();
});

test("zero regression: copy button still lands on diff blocks (038 FR-005)", async ({ page }) => {
  await page.goto("/?md=diff");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("apply it");
  await page.getByTestId("send-btn").click();
  const pre = page.locator(".markdown pre").first();
  await expect(pre.locator("code.language-diff")).toHaveCount(1, { timeout: 30_000 });
  await expect(pre.locator(".code-copy-btn")).toHaveCount(1);
});

test("diff block header paths are clickable file links (041 #9)", async ({ page }) => {
  await page.goto("/?md=diff");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("apply it");
  await page.getByTestId("send-btn").click();
  // Settled: the trailing footnote section is the reply's end.
  await expect(page.locator(".markdown section.footnotes")).toContainText("Follow-up notes.", { timeout: 30_000 });

  const diffCode = page.locator(".markdown pre code.language-diff");
  await expect(diffCode).toHaveCount(1);
  // Both header lines (--- a/… and +++ b/…) carry the file path as a link.
  const links = page.locator(".markdown pre .file-link");
  await expect(links).toHaveCount(2);
  const paths = await links.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path));
  expect(paths).toEqual(["src/main.tsx", "src/main.tsx"]);
  // Click the +++ header's path → ide.openFile receives it (mock echoes).
  await links.last().click();
  const echoed = await page.evaluate(() => globalThis.sessionStorage.getItem("pi-mock-open-file"));
  expect(echoed).toBe("src/main.tsx");
  // The path text is unchanged (linkify must not alter the diff content).
  const text = await diffCode.evaluate((el) => el.textContent || "");
  expect(text).toContain("--- a/src/main.tsx");
  expect(text).toContain("+++ b/src/main.tsx");
});
