// Read-only probe: eye-check the fixed surfaces at tool-window widths.
import { chromium } from "@playwright/test";

const URL = "http://localhost:5173";
const browser = await chromium.launch();
const page = await browser.newPage();
const shot = async (name) => page.screenshot({ path: `probe-${name}.png` });

for (const width of [430, 680]) {
  await page.setViewportSize({ width, height: 700 });
  await page.goto(URL + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await shot(`${width}-chat`);

  await page.getByTestId("options-btn").click();
  await page.waitForTimeout(200);
  await shot(`${width}-options`);
  await page.keyboard.press("Escape");

  await page.getByTestId("composer-input").pressSequentially("@src");
  await page.waitForTimeout(200);
  await shot(`${width}-atmenu`);
  await page.keyboard.press("Escape");
  await page.getByTestId("composer-input").fill("");

  await page.getByTestId("tab-sessions").click();
  await page.waitForTimeout(300);
  await shot(`${width}-sessions`);
}

// Reported geometry, so the numbers are on the record too.
await page.setViewportSize({ width: 430, height: 700 });
await page.goto(URL + "/", { waitUntil: "networkidle" });
const geo = await page.evaluate(() => {
  const r = (s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.right), Math.round(b.width), Math.round(b.height)];
  };
  return {
    viewport: document.documentElement.clientWidth,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    messageCol: r(".message-col"),
    composerInner: r(".composer-inner"),
    emptyState: r(".empty-state"),
  };
});
console.log(JSON.stringify(geo));

await browser.close();
