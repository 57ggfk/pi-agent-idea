import { expect, test } from "@playwright/test";

/**
 * Inline SVG rendering (039): legal SVG renders inside the message bubble,
 * malicious vectors (script / foreignObject / remote href) are stripped by
 * the same DOMPurify pass, malformed SVG degrades without breaking the
 * message.
 */

test("legal inline SVG renders inside the bubble, size-constrained (039 US1)", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show icons");
  await page.getByTestId("send-btn").click();

  // THREE <svg> elements survive sanitization, and that is correct:
  //   1) the legal one (renders the circle),
  //   2) the malicious one — only its script / foreignObject / remote href
  //      are stripped, the <svg> shell itself stays (it draws nothing),
  //   3) the malformed one — the browser's parser recovers the unclosed tag
  //      into an EMPTY <svg>, i.e. the documented degrade (FR-004).
  // The old "2" expectation was written before the mock grew the malformed
  // case; counting 2 made this spec red while the product was correct.
  const svg = page.locator(".markdown svg[viewBox='0 0 20 20']");
  await expect(svg).toHaveCount(4, { timeout: 30_000 });
  // The legal circle survives… (twice: the bare SVG and the ```svg fence —
  // 048 renders fenced SVG as a graphic too).
  await expect(page.locator(".markdown svg circle[r='8']")).toHaveCount(2);
  // …and is constrained by the container (FR-001).
  const constraint = await page.evaluate(() => {
    const el = document.querySelector(".markdown svg circle[r='8']")!.closest("svg")!;
    const s = getComputedStyle(el);
    const bubble = el.closest(".markdown")!;
    return { maxW: s.maxWidth, bubbleW: bubble.clientWidth, w: el.getBoundingClientRect().width };
  });
  expect(constraint.maxW === "100%" || constraint.maxW.endsWith("px")).toBe(true);
});

test("malicious SVG vectors are stripped: no script, no foreignObject, no remote href (039 US2)", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show icons");
  await page.getByTestId("send-btn").click();
  await expect(page.locator(".markdown svg")).toHaveCount(4, { timeout: 30_000 });
  // Anchor on the dangerous SVG being FULLY streamed: its <a> (the remote> (the remote
  // link the sanitizer must strip) only exists once the whole graphic has
  // arrived — counting the <svg> elements alone can win the race against the
  // stream and make the remote-link audit below a false green.
  await expect(page.locator(".markdown svg a")).toHaveCount(1, { timeout: 30_000 });

  const audit = await page.evaluate(() => {
    const root = document.querySelector(".markdown")!;
    // NB: `querySelectorAll("[xlink\\:href]")` cannot match a namespaced
    // attribute in an HTML document — that is why the old remote-href check
    // was a false green. Walk the elements and read the attributes instead.
    const remoteLinks = Array.from(root.querySelectorAll("*")).filter((el) => {
      const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
      return /^https?:/i.test(href);
    }).length;
    return {
      scripts: root.querySelectorAll("script").length,
      foreignObjects: root.querySelectorAll("foreignObject").length,
      remoteLinks,
      evilHost: root.innerHTML.includes("evil.example"),
      rectSurvives: root.querySelectorAll("rect").length,
    };
  });
  expect(audit.scripts).toBe(0);
  expect(audit.foreignObjects).toBe(0);
  expect(audit.remoteLinks).toBe(0);
  expect(audit.evilHost).toBe(false);
});

test("a malformed SVG degrades without breaking the message (039 FR-004)", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show icons");
  await page.getByTestId("send-btn").click();
  // The message as a whole still rendered its prose + both SVG groups.
  await expect(page.locator(".markdown", { hasText: "Icon:" })).toContainText("Malformed:", { timeout: 30_000 });
  await expect(page.locator(".markdown", { hasText: "Icon:" })).toContainText("Icon:");
  // No error banner / blank panel — the prose after the malformed SVG renders.
  await expect(page.locator(".markdown", { hasText: "Icon:" })).toContainText("Danger:");
});

test("a fenced SVG block renders as a graphic, its source stays copyable (048 FR-005 / 039 #6 revision)", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show icons");
  await page.getByTestId("send-btn").click();
  // Tail-anchored: both fenced blocks are the reply's final chunks.
  // The mock streams the reply word by word, so "two <code> elements exist"
  // is NOT "the second fence is complete" — an UNTERMINATED fence already
  // renders as a language-svg block carrying partial text. Waiting on the
  // count alone made this assertion race the stream.
  const fenced = page.locator(".markdown pre code.language-svg");
  await expect(fenced).toHaveCount(2, { timeout: 30_000 });
  await expect(fenced.filter({ hasText: "alert(1)" })).toHaveCount(1, { timeout: 30_000 });
  // Settle the stream: the fences only render their graphic once complete.
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });

  // 048: a ```svg fence renders as a graphic — the bare SVG and the fenced
  // copy of the same markup both show up now (039 #6's old boundary — "fence
  // = source, never a graphic" — is superseded by the 2026-11-20 request).
  await expect(page.locator(".markdown .svg-figure svg circle[r='8']")).toHaveCount(1);
  await expect(page.locator(".markdown svg circle[r='8']")).toHaveCount(2);

  const fencedAudit = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll(".markdown pre code.language-svg"));
    return {
      legal: blocks.some((b) => (b.textContent ?? "").includes('<circle cx="10"')),
      evilText: blocks.some((b) => (b.textContent ?? "").includes("<script>alert(1)</script>")),
      scripts: document.querySelectorAll(".markdown script").length,
      foreignObjects: document.querySelectorAll(".markdown foreignObject").length,
      figures: document.querySelectorAll(".markdown .svg-figure svg").length,
    };
  });
  // The fenced source is still there (copyable / open-in-IDE)…
  expect(fencedAudit.legal).toBe(true);
  expect(fencedAudit.evilText).toBe(true);
  // …and nothing dangerous came through the render.
  expect(fencedAudit.scripts).toBe(0);
  expect(fencedAudit.foreignObjects).toBe(0);
  expect(fencedAudit.figures).toBe(1);

  // "源码可复制" is user-reachable: the shared action bar (Copy + open in IDE)
  // is injected on the fenced source block too.
  const sourcePre = page.locator(".markdown pre", { hasText: 'circle cx="10"' });
  const sourceActions = sourcePre.locator("xpath=..").locator(".block-actions");
  await expect(sourceActions.locator(".code-copy-btn")).toHaveCount(1);
  await expect(sourceActions.locator(".code-ide-btn")).toHaveCount(1);
});

test("a fenced malicious SVG is sanitized and degrades to source (048 FR-005 / 039 US2)", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show icons");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });

  const evil = page.locator(".markdown pre", { hasText: "alert(1)" });
  await expect(evil).toHaveCount(1);
  // The script is stripped → nothing is painted → the block degrades back to
  // its source (no figure, no copy-as-image entry).
  await expect(evil.locator(".svg-figure")).toHaveCount(0);
  const display = await evil.locator("code.language-svg").evaluate((el) => getComputedStyle(el).display);
  expect(display).not.toBe("none");
  expect(page.locator(".markdown script")).toHaveCount(0);
  expect(page.locator(".markdown foreignObject")).toHaveCount(0);
  await expect(evil.locator("xpath=..").locator(".copy-image-btn")).toHaveCount(0);
});

test("zero regression: file links and code blocks still work with SVG enabled (039 FR-005)", async ({ page }) => {
  await page.goto("/?md=svg");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("show icons");
  await page.getByTestId("send-btn").click();
  await expect(page.locator(".markdown svg")).toHaveCount(4, { timeout: 30_000 });
  // Code block highlight pipeline still runs (the copy button gets injected).
  await expect(page.locator(".markdown .code-copy-btn").first()).toHaveCount(1);
  // The message copy action still sees real text (no SVG corruption of the
  // source — the transcript keeps the raw markdown).
  await expect(page.locator(".markdown", { hasText: "Icon:" })).toContainText("Icon:");
});
