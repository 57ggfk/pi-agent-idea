import { expect, test } from "@playwright/test";

/**
 * KaTeX math rendering (040 US1): inline $…$ and block $$…$$ render as KaTeX,
 * inside the existing sanitize pass (FR-002) with zero regression elsewhere.
 * Mermaid (US2) is deliberately not implemented this round — FR-007 requires
 * a real-machine JCEF probe first (recorded as a TODO in the run report).
 */

const reply = (page: import("@playwright/test").Page) => page.locator(".markdown", { hasText: "Energy:" });

/** The mock streams word-by-word — math assertions need the settled round. */
async function sendMathPrompt(page: import("@playwright/test").Page) {
  await page.goto("/?md=math");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("do the math");
  await page.getByTestId("send-btn").click();
  await expect(reply(page)).toContainText("Energy:", { timeout: 30_000 });
  // Settled = the mock's final sentence (after the block math) arrived.
  await expect(reply(page)).toContainText("nasty one:", { timeout: 30_000 });
}

test("inline and block math render as KaTeX (040 US1)", async ({ page }) => {
  await sendMathPrompt(page);

  // Inline and block both produce KaTeX structures.
  const counts = await page.evaluate(() => {
    const root = Array.from(document.querySelectorAll(".markdown")).find((el) => el.textContent!.includes("Energy:"))!;
    return {
      katex: root.querySelectorAll(".katex").length,
      mathml: root.querySelectorAll("math").length,
      katexDisplay: root.querySelectorAll(".katex-display").length,
      rawDollarSum: (root.textContent ?? "").includes("$$\\sum"),
    };
  });
  expect(counts.katex).toBeGreaterThanOrEqual(2);
  expect(counts.mathml).toBeGreaterThanOrEqual(2);
  expect(counts.katexDisplay).toBeGreaterThanOrEqual(1);
  expect(counts.rawDollarSum).toBe(false);
});

test("math is sanitized: no script survives the formula body (040 FR-002)", async ({ page }) => {
  await sendMathPrompt(page);

  const audit = await page.evaluate(() => {
    const root = Array.from(document.querySelectorAll(".markdown")).find((el) => el.textContent!.includes("Energy:"))!;
    return {
      scripts: root.querySelectorAll("script").length,
      executed: (window as { __pwned?: boolean }).__pwned === true,
      mathStillRenders: root.querySelectorAll(".katex").length,
    };
  });
  expect(audit.scripts).toBe(0);
  expect(audit.executed).toBe(false);
  expect(audit.mathStillRenders).toBeGreaterThanOrEqual(2);
});

test("zero regression: code blocks and footnotes still render beside math (040 FR-005)", async ({ page }) => {
  await sendMathPrompt(page);
  // The same round's tool-card code block still gets its copy button and hljs.
  await expect(page.locator(".markdown .code-copy-btn").first()).toHaveCount(1);
  await expect(page.locator(".markdown pre code.hljs").first()).toHaveCount(1);
});

test("a formula whose closing $ is followed by a clause mark still renders (040 revision)", async ({ page }) => {
  await sendMathPrompt(page);
  // The mock's "Trailing marks" line ends each formula with `;` `)` `、`.
  // Upstream's rule required whitespace/punctuation from a narrow set after
  // the closing `$`, so these three stayed raw `$…$` text. They must now be
  // KaTeX structures — and the RAW dollar text must be gone.
  const audit = await page.evaluate(() => {
    const root = Array.from(document.querySelectorAll(".markdown")).find((el) =>
      el.textContent!.includes("Energy:"),
    )!;
    const text = root.textContent ?? "";
    return {
      rawLeft: text.includes("$x+1$") || text.includes("$y+2$") || text.includes("$z+3$"),
      katex: root.querySelectorAll(".katex").length,
    };
  });
  expect(audit.rawLeft).toBe(false);
  expect(audit.katex).toBeGreaterThanOrEqual(5);
});
