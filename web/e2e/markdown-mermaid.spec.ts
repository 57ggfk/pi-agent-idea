import { expect, test } from "@playwright/test";

/**
 * Mermaid diagram rendering (040 US2): ```mermaid blocks render as diagrams
 * inside the message; a syntax-error block degrades to its source code; the
 * pipeline stays inside the DOMPurify-sanitized world (FR-005) and the
 * diagram is size-constrained (FR-003).
 */

const reply = (page: import("@playwright/test").Page) =>
  page.locator(".markdown", { hasText: "Valid:" });

async function sendMermaidReply(page: import("@playwright/test").Page) {
  await page.goto("/?md=mermaid");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("draw it");
  await page.getByTestId("send-btn").click();
  await expect(reply(page)).toContainText("Valid:", { timeout: 30_000 });
  // Settled: the broken block's source (end of the reply) has arrived.
  await expect(reply(page)).toContainText("Broken:", { timeout: 30_000 });
  // Settled: "bad syntax >>>" is the reply's LAST line — the paragraph header
  // streams ahead of its fence content, so only the tail line proves the
  // full text landed (mock streams word by word; mid-stream assertions race).
  await expect(reply(page)).toContainText("bad syntax >>>", { timeout: 30_000 });
  // mermaid loads lazily and renders async AFTER the text lands; streaming
  // re-renders make the figure tree transient (partial prefixes can render a
  // tiny valid diagram for a moment). Wait for the TERMINAL state instead of
  // a point-in-time count: exactly one figure (the valid block) and every
  // broken block's source visible again — from there the DOM is stable.
  await expect(async () => {
    const s = await page.evaluate(() => ({
      figures: document.querySelectorAll(".mermaid-figure svg").length,
      hiddenBroken: [...document.querySelectorAll(".markdown pre code.language-mermaid")].filter(
        (c) => /A --> \];|bad syntax >>>/.test(c.textContent || "") && getComputedStyle(c).display === "none",
      ).length,
    }));
    expect(s.figures).toBe(1);
    expect(s.hiddenBroken).toBe(0);
  }).toPass({ timeout: 20_000 });
  // AND wait for the whole stream (text + tool calls) to end: the trailing
  // message_update events still wipe .markdown, which swallows clicks that
  // land in that window.
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

test("a valid mermaid block renders as a diagram (040 US2)", async ({ page }) => {
  await sendMermaidReply(page);
  const fig = reply(page).locator(".mermaid-figure svg");
  await expect(fig).toHaveCount(1);
  // The diagram keeps its labels (svg text nodes, htmlLabels off or on).
  const label = await fig.evaluate((el) => (el.textContent || "").includes("Start"));
  expect(label).toBe(true);
  // Size-constrained to the bubble (FR-003).
  const w = await fig.evaluate((el) => {
    const s = getComputedStyle(el);
    return { maxW: s.maxWidth, w: el.getBoundingClientRect().width, bubble: el.closest(".markdown")!.clientWidth };
  });
  expect(w.w).toBeLessThanOrEqual(w.bubble);
});

test("a broken mermaid block degrades to its source code (040 FR-004)", async ({ page }) => {
  await sendMermaidReply(page);
  // The broken block keeps its visible source code (no figure replaced it).
  const broken = reply(page).locator("pre").filter({
    has: page.locator("code.language-mermaid", { hasText: "A --> ];" }),
  });
  await expect(broken).toHaveCount(1);
  await expect(broken.locator(".mermaid-figure")).toHaveCount(0);
  const visible = await broken.locator("code.language-mermaid").evaluate((el) => getComputedStyle(el).display);
  expect(visible).not.toBe("none");
});

test("mermaid output is sanitized: no script, no inline handlers (040 FR-002/FR-005)", async ({ page }) => {
  await sendMermaidReply(page);
  const audit = await reply(page).evaluate((el) => ({
    scripts: el.querySelectorAll("script").length,
    onEvents: el.querySelectorAll("[onclick], [onload], [onerror]").length,
    figures: el.querySelectorAll(".mermaid-figure svg").length,
  }));
  expect(audit.scripts).toBe(0);
  expect(audit.onEvents).toBe(0);
  expect(audit.figures).toBe(1);
});

test("broken blocks leak no error nodes into <body> (040 #5)", async ({ page }) => {
  await sendMermaidReply(page);
  const leak = await page.evaluate(() => {
    const orphans = [...document.body.children].filter((el) => /^pi-mermaid-/.test(el.id));
    return {
      orphans: orphans.length,
      syntaxErrorText: (document.body.innerText.match(/Syntax error in text/g) || []).length,
      brokenSources: [...document.querySelectorAll(".markdown pre")].filter((p) => {
        const t = p.textContent || "";
        return /A --> \];/.test(t) || /bad syntax >>>/.test(t);
      }).length,
      figures: document.querySelectorAll(".mermaid-figure svg").length,
    };
  });
  // Neither failure may leave mermaid's own error node outside the message
  // list (040 #5: they used to pile up under <body> across re-renders).
  expect(leak.orphans).toBe(0);
  expect(leak.syntaxErrorText).toBe(0);
  // Both distinct broken sources degraded to visible source blocks…
  expect(leak.brokenSources).toBe(2);
  // …and the valid diagram still rendered exactly once.
  expect(leak.figures).toBe(1);
});

test("zero regression: the copy button still works on the mermaid source (040 FR-005)", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await sendMermaidReply(page);
  // The valid block's code element is hidden but still holds the source; the
  // broken block's copy button is the plain-path one to exercise. The action
  // bar lives in the block's shell, outside the `pre`.
  const brokenPre = reply(page)
    .locator("pre")
    .filter({ has: page.locator("code.language-mermaid", { hasText: "A --> ];" }) });
  const brokenCopy = brokenPre.locator("xpath=..").locator(".code-copy-btn");
  await brokenPre.hover();
  await brokenCopy.click();
  // The stale-figure heal may reflow the bar right at click time; give the
  // flash a wider window.
  await expect(brokenCopy).toHaveText("✓", { timeout: 10_000 });
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("A --> ];");
});

/**
 * Relative luminance of a CSS color (0 = black, 1 = white). Fully
 * transparent colors return -1 ("no opinion") so a caller can take the
 * brightest of several candidates.
 */
function luminance(color: string): number {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return -1;
  const parts = m[1].split(",").map((v) => Number(v.trim()));
  const [r, g, b] = parts;
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (alpha === 0) return -1;
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

test("the diagram follows the panel theme (2026-11-20 real-machine review)", async ({ page }) => {
  await sendMermaidReply(page);
  const palette = () =>
    page.evaluate(() => {
      const fig = document.querySelector(".markdown .mermaid-figure") as HTMLElement;
      const svg = document.querySelector(".markdown .mermaid-figure svg") as SVGSVGElement;
      const rect = svg.querySelector(".node rect") as SVGRectElement;
      const label = svg.querySelector(".nodeLabel, .label") as SVGElement | null;
      const ls = label ? getComputedStyle(label) : null;
      return {
        theme: document.documentElement.dataset.theme,
        mermaidTheme: fig.dataset.mermaidTheme ?? "",
        fill: rect ? getComputedStyle(rect).fill : "",
        labelColor: ls ? ls.color : "",
        labelFill: ls ? ls.fill : "",
      };
    });

  const light = await palette();
  expect(light.theme).toBe("light");
  expect(light.mermaidTheme).toBe("default");
  // Light panel → light diagram (mermaid's own light palette).
  expect(luminance(light.fill)).toBeGreaterThan(0.5);

  // Switch the panel to the dark theme: the diagram must follow it. Before
  // the fix it kept mermaid's light theme, so a dark IDE showed a white-boxed
  // diagram next to the IDE's own dark mermaid preview.
  await page.getByTestId("options-btn").click();
  await page.getByTestId("opt-theme-dark").click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await palette()).theme).toBe("dark");
  await expect.poll(async () => (await palette()).mermaidTheme).toBe("dark");
  await expect.poll(async () => luminance((await palette()).fill)).toBeLessThan(0.2);
  const dark = await palette();
  // Dark boxes, light labels — the diagram is readable in the dark bubble.
  expect(Math.max(luminance(dark.labelColor), luminance(dark.labelFill))).toBeGreaterThan(0.5);
});
