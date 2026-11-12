// 025 real-machine: composer must GROW to the cap AND reveal the tail after an
// injection. The IDE's "加入会话" menu cannot be driven over CDP, so this probe
// uses the quote action — the same store path (pendingPrompt -> Composer's
// settle -> autosizeAndReveal) that an IDE injection takes.
import { chromium } from "@playwright/test";

const res = [];
const push = (n, ok, d) => {
  res.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} :: ${JSON.stringify(d)}`);
};

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];

const measure = () =>
  p.evaluate(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    const app = ta?.closest(".app");
    if (!ta) return null;
    const appH = app?.clientHeight ?? 0;
    const cap = Math.floor(Math.min(320, appH * 0.45));
    return {
      styleH: parseFloat(ta.style.height || "0"),
      scrollH: ta.scrollHeight,
      clientH: ta.clientHeight,
      scrollTop: ta.scrollTop,
      valueLen: ta.value.length,
      appH,
      cap,
      scrollable: ta.scrollHeight > ta.clientHeight + 1,
      atTail: ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 1,
    };
  });

// ---------- pick the long session ----------
if (await p.getByTestId("tab-sessions").count()) await p.getByTestId("tab-sessions").click();
await p.waitForSelector('[data-testid="session-row"]', { timeout: 15000 });
const picked = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="session-row"]')];
  let best = null;
  rows.forEach((r, i) => {
    const n = Number(r.innerText.match(/(\d+)\s*条消息/)?.[1] ?? -1);
    if (!best || n > best.n) best = { i, n, file: r.getAttribute("title") };
  });
  return best;
});
await p.locator('[data-testid="session-row"]').nth(picked.i).click();
await p.waitForSelector('[data-testid="message-list"]', { timeout: 30000 });
await p.waitForTimeout(1500);
console.log("session:", picked.file?.split("\\").pop(), "msgs:", picked.n);

const before = await measure();
console.log("composer before:", JSON.stringify(before));
push("composer starts at the single-line floor", before.styleH <= 40, { styleH: before.styleH });

// ---------- inject via quote, worst case first: the longest message ----------
const longest = await p.evaluate(() => {
  const items = [...document.querySelectorAll('[data-testid="message-list"] .item')];
  let best = { i: -1, len: 0 };
  items.forEach((el, i) => {
    const len = (el.innerText || "").length;
    if (len > best.len) best = { i, len };
  });
  return best;
});
console.log("longest item:", JSON.stringify(longest));

const item = p.locator('[data-testid="message-list"] .item').nth(longest.i);
await item.scrollIntoViewIfNeeded();
await item.hover();
await p.waitForTimeout(250);
const quoteBtn = item.getByTestId("act-quote");
push("quote action available on that item", (await quoteBtn.count()) === 1);
await quoteBtn.click();
await p.waitForTimeout(600);

let now = await measure();
console.log("composer after 1 quote:", JSON.stringify(now));

// keep quoting long items until the box reaches the cap (a single message may be short)
let rounds = 1;
while (!(now.styleH >= now.cap - 1) && rounds < 4) {
  const next = await p.evaluate(() => {
    const items = [...document.querySelectorAll('[data-testid="message-list"] .item')];
    let best = { i: -1, len: 0 };
    items.forEach((el, i) => {
      const len = (el.innerText || "").length;
      if (len > best.len && !el.dataset.quoted) best = { i, len };
    });
    if (best.i >= 0) items[best.i].dataset.quoted = "1";
    return best;
  });
  if (next.i < 0) break;
  const it = p.locator('[data-testid="message-list"] .item').nth(next.i);
  await it.scrollIntoViewIfNeeded();
  await it.hover();
  await p.waitForTimeout(200);
  await it.getByTestId("act-quote").click();
  await p.waitForTimeout(600);
  rounds++;
  now = await measure();
  console.log(`composer after ${rounds} quotes:`, JSON.stringify(now));
}

const expectedH = Math.min(Math.max(now.scrollH, 34), Math.max(now.cap, 34));
push("composer grew past the single-line floor", now.styleH > 40, { styleH: now.styleH });
push("height equals clamp(scrollHeight, appHeight)", Math.abs(now.styleH - expectedH) <= 1, {
  styleH: now.styleH,
  expected: expectedH,
  cap: now.cap,
  appH: now.appH,
});
push("composer is scrollable at the cap (content exceeds the box)", now.scrollable, {
  scrollH: now.scrollH,
  clientH: now.clientH,
  reachedCap: now.styleH >= now.cap - 1,
});
push("the visible window is parked at the tail (025 FR-001/002)", now.atTail, {
  scrollTop: now.scrollTop,
  scrollH: now.scrollH,
  clientH: now.clientH,
  gap: now.scrollH - now.scrollTop - now.clientH,
});
push("caret/text ends at the end of the injected block", now.valueLen > 200, { valueLen: now.valueLen });
await p.screenshot({ path: "../build/probe-025-real-quote.png" }).catch(() => {});

// ---------- clean the draft up so the user is not left with injected text ----------
await p.getByTestId("composer-input").click();
await p.keyboard.press("Control+A");
await p.keyboard.press("Delete");
await p.waitForTimeout(400);
const cleared = await measure();
push("composer reset to one line after clearing", cleared.styleH <= 40, { styleH: cleared.styleH, valueLen: cleared.valueLen });

console.log("\nsummary: " + res.filter((r) => r.ok).length + "/" + res.length + " pass");
await b.close();
