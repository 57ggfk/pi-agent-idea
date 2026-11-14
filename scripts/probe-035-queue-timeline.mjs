import { chromium } from "playwright";
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto("http://localhost:5173/?pkgs=2&pkgspeed=slow");
await page.getByTestId("empty-state").waitFor();
await page.getByTestId("tab-manage").click();
await page.getByTestId("manage-tab-packages").click();
await page.getByTestId("package-row").first().waitFor();
await page.getByTestId("package-remove-1").click();
await page.getByTestId("confirm-ok").click();
await page.getByTestId("package-remove-0").click();
await page.getByTestId("confirm-ok").click();
const t0 = Date.now();
for (let i = 0; i < 20; i++) {
  const s = await page.evaluate(() => ({
    prog1: !!document.querySelector("[data-testid=package-progress-1]"),
    prog1text: document.querySelector("[data-testid=package-progress-1]")?.textContent ?? "",
    queued0: !!document.querySelector("[data-testid=package-queued-0]"),
    queued1: !!document.querySelector("[data-testid=package-queued-1]"),
    activeCls: document.querySelector(".pkg-row-active")?.querySelector(".panel-row-title")?.textContent?.slice(0, 20) ?? null,
  }));
  console.log(Date.now() - t0, JSON.stringify(s));
  if (!s.prog1 && !s.queued0 && !s.queued1) break;
  await page.waitForTimeout(200);
}
await b.close();
