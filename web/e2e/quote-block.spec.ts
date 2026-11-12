import { expect, test, type Page } from "@playwright/test";

/**
 * Quote rendering (`> ` blockquote), which is also what the "引用消息" action
 * produces once the message is sent (`quoteMarkdownSource`).
 *
 * `styles.css` had no `blockquote` rule at all, so the UA default
 * (`margin: 1em 40px`, no border) won: inside a 360px tool window the text
 * lost 80px of width and nothing marked it as a quote. These assertions pin
 * the replacement — flush left, a 3px bar, no width loss — so a future reset
 * or a stray `margin` cannot bring the whitespace back silently.
 */

const QUOTED = "这是一段被引用的原文，用来检查引用块左侧是否还有多余的空白。";

async function ask(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
}

/** Geometry + the two computed properties that encode "this is a quote". */
async function quoteBox(quote: ReturnType<Page["locator"]>) {
  return quote.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const host = (el.closest(".markdown") as HTMLElement).getBoundingClientRect();
    const body = (el.closest(".item-body") as HTMLElement).getBoundingClientRect();
    return {
      marginLeft: cs.marginLeft,
      marginRight: cs.marginRight,
      borderLeftWidth: cs.borderLeftWidth,
      borderLeftColor: cs.borderLeftColor,
      paddingLeft: cs.paddingLeft,
      // Distance from the message's own left edge to the bar.
      indent: Math.round(r.left - host.left),
      // How much of the bubble the quote claims, and whether it overflows.
      width: Math.round(r.width),
      hostWidth: Math.round(host.width),
      overflowsRight: Math.round(r.right - host.right),
      overflowsBodyRight: Math.round(r.right - body.right),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("a quoted message renders as a flush-left blockquote with a bar", async ({ page }) => {
  await ask(page, `> ${QUOTED}\n\n我的问题在这句。`);

  const user = page.getByTestId("item-user").last();
  const quote = user.locator("blockquote");
  await expect(quote).toHaveCount(1);
  await expect(quote).toContainText(QUOTED);

  const box = await quoteBox(quote);
  // UA default margins are the bug: 40px on each side.
  expect(box.marginLeft).toBe("0px");
  expect(box.marginRight).toBe("0px");
  // The bar is what makes it read as a quote at all.
  expect(box.borderLeftWidth).toBe("3px");
  // Flush left: only the bar + its 10px padding stand between the bubble edge
  // and the text, so the indent stays under a character.
  expect(box.indent).toBeLessThanOrEqual(1);
  // And the quote must use the full width it was given, never spill.
  expect(box.overflowsRight).toBeLessThanOrEqual(1);
  expect(box.overflowsBodyRight).toBeLessThanOrEqual(1);
  expect(box.width).toBeGreaterThan(box.hostWidth - 20);

  await page.locator('[data-testid="message-list"]').screenshot({ path: "build/quote-block-user.png" });
});

test("the same quote in an assistant message is styled identically", async ({ page }) => {
  // The mock echoes the prompt, so asking with a quote puts one in both roles.
  await ask(page, `> ${QUOTED}\n\n重复给我看`);
  await expect(page.getByTestId("item-assistant").last()).toBeVisible({ timeout: 20_000 });

  const quotes = page.locator("blockquote");
  const n = await quotes.count();
  expect(n).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < n; i++) {
    const box = await quoteBox(quotes.nth(i));
    expect(box.marginLeft).toBe("0px");
    expect(box.borderLeftWidth).toBe("3px");
    expect(box.indent).toBeLessThanOrEqual(1);
    expect(box.overflowsRight).toBeLessThanOrEqual(1);
  }
});
