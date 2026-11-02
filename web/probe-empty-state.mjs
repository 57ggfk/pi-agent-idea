// Read-only probe: where does the empty-state icon sit at various widths?
import { chromium } from "@playwright/test";

const URL = "http://localhost:5173";
const browser = await chromium.launch();
const page = await browser.newPage();

const measure = () =>
  page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        left: Math.round(b.left),
        right: Math.round(b.right),
        width: Math.round(b.width),
        center: Math.round(b.left + b.width / 2),
      };
    };
    const list = document.querySelector(".message-list");
    const cs = list ? getComputedStyle(list) : null;
    const de = document.documentElement;
    const overflowing = Array.from(document.querySelectorAll("*"))
      .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1)
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className || "-"}:right=${Math.round(el.getBoundingClientRect().right)}`);
    return {
      docScrollWidth: de.scrollWidth,
      docOverflow: de.scrollWidth - de.clientWidth,
      overflowing,
      viewport: de.clientWidth,
      app: r(".app"),
      list: r(".message-list"),
      listClientWidth: list ? list.clientWidth : null,
      listScrollWidth: list ? list.scrollWidth : null,
      listPadding: cs ? `${cs.paddingLeft}/${cs.paddingRight}` : null,
      listGutter: cs ? cs.scrollbarGutter : null,
      col: r(".message-col"),
      emptyCount: document.querySelectorAll(".empty-state").length,
      empty: r(".empty-state"),
      logo: r(".empty-logo"),
      title: r(".empty-title"),
      logoInner: (() => {
        const el = document.querySelector(".empty-logo");
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: Math.round(b.left), width: Math.round(b.width), center: Math.round(b.left + b.width / 2) };
      })(),
      composer: r(".composer-inner"),
    };
  });

for (const width of [360, 520, 680, 760, 900, 1100, 1440]) {
  await page.setViewportSize({ width, height: 760 });
  await page.goto(URL + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const m = await measure();
  console.log(JSON.stringify({ width, ...m }));
}

await browser.close();
