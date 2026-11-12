// 031 real-machine, success path: fill a fresh session past pi's default
// keepRecentTokens (20000) so manual compaction actually summarizes, then
// verify under zh and en:
//   - a compaction_start EVENT notice appears (proves the RPC forwards
//     compaction events — the same channel auto compaction uses);
//   - the compacted notice carries locale-grouped token figures;
//   - after switching to en the wording is verbatim pre-031 and the zh
//     notices are not retranslated (FR-005).
//
// Fillers are ~10k-char Chinese paragraphs; replies are "收到" so the
// summarization input is dominated by the fillers. Auto compaction would
// need ~112k tokens on this 128k-window model — out of budget, recorded as
// a manual item (the start-event proxy evidence covers the event channel).
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const res = [];
const push = (n, ok, d) => {
  res.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} :: ${JSON.stringify(d).slice(0, 300)}`);
};

const FILLER =
  "这是一段用于撑大会话上下文的填充文本，围绕压缩提示国际化验证的场景设计：产品团队在周一晨会上回顾了消息流系统通知的多语言呈现问题，" +
  "确认了压缩开始、完成与失败三类提示需要在中文与英文界面下各自正确显示，并且历史提示不随界面语言切换而重译，" +
  "同时决定把 token 数字的千分位分组交给 Intl 数字格式化按当前语言处理，失败原因保留 pi 返回的原文不翻译。";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];
const redact = (u) => u.replace(/([?&]token=)[^&#]*/gi, "$1<redacted>");

const sysItems = () =>
  p.evaluate(() =>
    [...document.querySelectorAll('[data-testid="system-item"]')].map((el) => el.textContent.trim()),
  );
const state = () =>
  p.evaluate(() => ({
    tabChat: document.querySelector('[data-testid="tab-chat"]')?.textContent ?? null,
    compactLabel: document.querySelector('[data-testid="compact-btn"]')?.textContent?.trim() ?? null,
    assistants: document.querySelectorAll('[data-testid="item-assistant"]').length,
    busy: document.querySelector('[data-testid="status-dot"]')?.classList.contains("busy") ?? false,
    ctxText: document.querySelector('[data-testid="status-context"]')?.textContent ?? null,
  }));

async function sendFill(n) {
  const text = `031探针填充第${n}轮。${FILLER.repeat(50)}\n\n请只回复：收到`;
  const before = (await state()).assistants;
  await p.getByTestId("composer-input").fill(text);
  await p.getByTestId("send-btn").click();
  await p.waitForFunction(
    (k) =>
      document.querySelectorAll('[data-testid="item-assistant"]').length > k &&
      !document.querySelector('[data-testid="status-dot"]')?.classList.contains("busy"),
    before,
    { timeout: 120_000 },
  );
  return (await state()).ctxText;
}

await p.waitForSelector('[data-testid="tabs"]', { timeout: 20000 });
const initialTab = await p.evaluate(() => document.querySelector('[data-testid="tab-chat"]')?.textContent ?? null);
const initialLang = initialTab === "聊天" ? "zh" : "en";
if (initialLang !== "zh") {
  await p.getByTestId("options-btn").click();
  await p.getByTestId("opt-language-zh").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="tab-chat"]')?.textContent === "聊天", null, { timeout: 10000 });
}
push("UI language is Chinese", (await state()).tabChat === "聊天", {});

// fresh session (confirm dialog when the previous session had content)
await p.getByTestId("new-session").click();
await p.waitForTimeout(400);
if ((await p.locator('[data-testid="confirm-dialog"]').count()) > 0) await p.getByTestId("confirm-ok").click();
await p.waitForTimeout(600);
push("fresh empty session", await p.evaluate(() => document.querySelectorAll('[data-testid="item-assistant"]').length === 0), {});

// ---- fill past the 20k keepRecentTokens default (target ~40k tokens) ----
let ctx = "ctx 0%";
const sysAtStart = (await sysItems()).length;
for (let i = 1; i <= 14; i++) {
  ctx = await sendFill(i);
  const sys = await sysItems();
  const spontaneous = sys.slice(sysAtStart);
  if (spontaneous.length > 0) {
    console.log("  spontaneous system notices during fill:", JSON.stringify(spontaneous));
  }
  console.log(`  fill ${i}: ${ctx}`);
  const pct = Number(ctx.match(/ctx (\d+)%/)?.[1] ?? 0);
  if (pct >= 40) break;
}
push("context filled past the compaction threshold", Number(ctx.match(/ctx (\d+)%/)?.[1] ?? 0) >= 20, { ctxText: ctx });

// ---- compact under zh; watch for the start notice BEFORE the end notice ----
const before1 = (await sysItems()).length;
await p.getByTestId("compact-btn").click();
const notices1 = [];
const deadline1 = Date.now() + 240_000;
while (Date.now() < deadline1) {
  const sys = await sysItems();
  if (sys.length > before1 + notices1.length) {
    notices1.push(sys[sys.length - 1]);
    console.log(`  zh notice #${notices1.length} (+${Date.now() - deadline1 + 240000}ms):`, sys[sys.length - 1]);
  }
  if (!!(await state()).busy === false && sys.length > before1 && notices1.length >= 1) {
    const settled = await p.evaluate(() => !document.querySelector('[data-testid="status-dot"]')?.classList.contains("busy"));
    if (settled && /tokens。$/.test(sys[sys.length - 1])) break;
  }
  await p.waitForTimeout(400);
}
console.log("zh notices:", JSON.stringify(notices1));
const zhStart = notices1.find((t) => t.startsWith("正在压缩上下文"));
const zhEnd = notices1.find((t) => /^上下文已压缩：[\d,]+ → [\d,]+ tokens。$/.test(t));
push("zh compaction_start event notice appears (RPC forwards compaction events)", zhStart != null, { zhStart });
push("zh compacted notice with grouped tokens (US1)", zhEnd != null, { zhEnd });

// ---- more content, then compact under en ----
for (let i = 15; i <= 20; i++) {
  ctx = await sendFill(i);
  console.log(`  fill ${i}: ${ctx}`);
}
const before2 = (await sysItems()).length;
await p.getByTestId("options-btn").click();
await p.getByTestId("opt-language-en").click();
await p.waitForFunction(() => document.querySelector('[data-testid="tab-chat"]')?.textContent === "Chat", null, { timeout: 10000 });
const enState = await state();
push("UI switched to English; label is Compact", enState.compactLabel === "Compact", { label: enState.compactLabel });

await p.getByTestId("compact-btn").click();
const notices2 = [];
const deadline2 = Date.now() + 240_000;
while (Date.now() < deadline2) {
  const sys = await sysItems();
  if (sys.length > before2 + notices2.length) {
    notices2.push(sys[sys.length - 1]);
    console.log(`  en notice #${notices2.length}:`, sys[sys.length - 1]);
  }
  const settled = await p.evaluate(() => !document.querySelector('[data-testid="status-dot"]')?.classList.contains("busy"));
  if (settled && sys.length > before2 && /tokens\.$/.test(sys[sys.length - 1] ?? "")) break;
  await p.waitForTimeout(400);
}
console.log("en notices:", JSON.stringify(notices2));
const enStart = notices2.find((t) => t.startsWith("Compacting context ("));
const enEnd = notices2.find((t) => /^Context compacted: [\d,]+ → [\d,]+ tokens\.$/.test(t));
push("en compaction_start event notice verbatim (US5)", enStart != null, { enStart });
push("en compacted notice verbatim pre-031 wording (US5)", enEnd != null, { enEnd });

// ---- zh notices survive the language switch (FR-005) ----
const finalSys = await sysItems();
push(
  "zh notices not retranslated after switching to en (FR-005)",
  finalSys.some((t) => t === zhStart) && finalSys.some((t) => t === zhEnd),
  { zhStart, zhEnd },
);

// restore the initial language
if (initialLang !== "en") {
  await p.getByTestId("options-btn").click();
  await p.getByTestId(initialLang === "zh" ? "opt-language-zh" : "opt-language-en").click();
  await p.waitForTimeout(800);
  console.log("language restored to:", initialLang);
}

const pass = res.filter((r) => r.ok).length;
const verdict = {
  when: new Date().toISOString(),
  pageUrl: redact(p.url()),
  results: res,
  pass,
  total: res.length,
  zhNotices: notices1,
  enNotices: notices2,
  ctxAfterFill: ctx,
};
const outDir = "../specs/031-compaction-i18n/evidence";
await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/probe-031-compaction-fill.json`, JSON.stringify(verdict, null, 2));
console.log(`\n${pass}/${res.length} PASS — verdict → ${outDir}/probe-031-compaction-fill.json`);
process.exit(pass === res.length ? 0 : 1);
