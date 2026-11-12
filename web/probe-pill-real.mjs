// 029 real-machine: pick the longest session by "N 条消息", scroll up, click the pill.
import { chromium } from "@playwright/test";
const OUT = (o) => console.log(JSON.stringify(o));
const res = [];
const push = (n, ok, d) => { res.push({ n, ok, d }); console.log(`${ok ? "PASS" : "FAIL"}  ${n} :: ${JSON.stringify(d)}`); };

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];

// 1. make sure we are on the sessions tab and pick the longest row
if (await p.locator('[data-testid="tab-sessions"]').count()) await p.getByTestId("tab-sessions").click();
await p.waitForSelector('[data-testid="session-row"]', { timeout: 15000 });

const pick = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="session-row"]')];
  let best = null;
  rows.forEach((r, i) => {
    const m = /(\d+)\s*条消息/.exec(r.innerText);
    const n = m ? +m[1] : -1;
    if (!best || n > best.n) best = { i, n, text: r.innerText.split("\n")[0].slice(0, 40) };
  });
  return best;
});
console.log("picked:", JSON.stringify(pick));

await p.locator('[data-testid="session-row"]').nth(pick.i).click();
await p.waitForSelector('[data-testid="message-list"]', { timeout: 30000 });
// wait until the transcript is actually tall
await p.waitForFunction(() => {
  const el = document.querySelector('[data-testid="message-list"]');
  return el && el.scrollHeight > el.clientHeight + 50;
}, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(1200);

const m0 = await p.evaluate(() => {
  const el = document.querySelector('[data-testid="message-list"]');
  return { h: el.scrollHeight, ch: el.clientHeight, top: el.scrollTop, items: el.querySelectorAll(".item").length,
           pill: document.querySelectorAll('[data-testid="jump-bottom"]').length };
});
push("long transcript loaded", m0.h > m0.ch + 50, m0);
push("pill hidden while pinned at bottom", m0.pill === 0, { pill: m0.pill });

// 2. scroll to top
await p.evaluate(() => { document.querySelector('[data-testid="message-list"]').scrollTop = 0; });
let appeared = false;
try { await p.waitForSelector('[data-testid="jump-bottom"]', { timeout: 4000 }); appeared = true; } catch {}
push("pill appears after scrolling to top", appeared);
await p.screenshot({ path: "../build/probe-029-real-pill.png" }).catch(() => {});

const before = await p.evaluate(() => {
  const el = document.querySelector('[data-testid="message-list"]');
  return { h: el.scrollHeight, top: el.scrollTop };
});

// 3. click -> lands at bottom
if (appeared) {
  await p.getByTestId("jump-bottom").click();
  let landed = false;
  try {
    await p.waitForFunction(() => {
      const el = document.querySelector('[data-testid="message-list"]');
      return el && el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
    }, { timeout: 6000 });
    landed = true;
  } catch {}
  push("click lands at bottom (<=4px)", landed);
  const after = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="message-list"]');
    return { h: el.scrollHeight, top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight,
             pill: document.querySelectorAll('[data-testid="jump-bottom"]').length };
  });
  push("scrollHeight unchanged by the pill", before.h === after.h, { before: before.h, after: after.h });
  push("pill removed after click", after.pill === 0, { pill: after.pill, gap: Math.round(after.gap) });
  await p.screenshot({ path: "../build/probe-029-real-after.png" }).catch(() => {});
}

// 4. scroll up a bit (not top) -> pill still appears; scroll back to bottom manually -> disappears
await p.evaluate(() => { document.querySelector('[data-testid="message-list"]').scrollTop = 400; });
await p.waitForTimeout(500);
push("pill appears on partial scroll-up", (await p.getByTestId("jump-bottom").count()) === 1);
await p.evaluate(() => { const el = document.querySelector('[data-testid="message-list"]'); el.scrollTop = el.scrollHeight; });
await p.waitForTimeout(700);
push("pill hides again when manually back at bottom", (await p.getByTestId("jump-bottom").count()) === 0);

console.log("\nsummary: " + res.filter(r => r.ok).length + "/" + res.length + " pass");
await b.close();
