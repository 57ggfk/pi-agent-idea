// 031 real-machine: manual compact shows a zh notice under a Chinese UI and an
// English notice (verbatim pre-031 wording) after switching to English, while
// the earlier notice stays zh — copy is snapshotted at generation time (FR-005).
//
// Runs against the real JCEF panel (CDP :9222). Uses a FRESH throwaway session
// with two short prompts so no real session gets compacted. Compact performs a
// real LLM call, so the budget is generous.
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const res = [];
const push = (n, ok, d) => {
  res.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} :: ${JSON.stringify(d)}`);
};

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
    onChat: !!document.querySelector('[data-testid="message-list"]'),
    assistants: document.querySelectorAll('[data-testid="item-assistant"]').length,
    busy: document.querySelector('[data-testid="status-dot"]')?.classList.contains("busy") ?? false,
    current: document.querySelector('[data-testid="session-row"].session-current .session-name')?.textContent ?? null,
  }));

await p.waitForSelector('[data-testid="tabs"]', { timeout: 20000 });

// ---- initial language snapshot, then force zh ----
const initialTab = await p.evaluate(() => document.querySelector('[data-testid="tab-chat"]')?.textContent ?? null);
console.log("initial tab text:", initialTab);
if (initialTab !== "聊天") {
  await p.getByTestId("options-btn").click();
  await p.getByTestId("opt-language-zh").click();
  await p.waitForFunction(() => document.querySelector('[data-testid="tab-chat"]')?.textContent === "聊天", null, {
    timeout: 10000,
  });
}
push("UI language is Chinese (tab=聊天)", (await state()).tabChat === "聊天", {});
const initialLang = initialTab === "聊天" ? "zh" : "en";

// ---- fresh session (handle the confirm dialog when the current session has content) ----
await p.getByTestId("new-session").click();
await p.waitForTimeout(400);
const dialog = await p.locator('[data-testid="confirm-dialog"]').count();
if (dialog > 0) {
  console.log("  confirm dialog shown — confirming");
  await p.getByTestId("confirm-ok").click();
}
await p.waitForFunction(() => document.querySelectorAll('[data-testid="item-user"], [data-testid="item-assistant"]').length === 0, null, { timeout: 15000 }).catch(() => {});
push("fresh empty session", await p.evaluate(() => document.querySelectorAll('[data-testid="item-assistant"]').length === 0), {});

// ---- two short prompts so compact has real content ----
const replyDeadline = 90_000;
for (const text of ["031探针第一条：请只回复收到", "031探针第二条：请只回复好"]) {
  await p.getByTestId("composer-input").fill(text);
  const before = (await state()).assistants;
  await p.getByTestId("send-btn").click();
  const t0 = Date.now();
  await p.waitForFunction(
    (n) =>
      document.querySelectorAll('[data-testid="item-assistant"]').length > n &&
      !document.querySelector('[data-testid="status-dot"]')?.classList.contains("busy"),
    before,
    { timeout: replyDeadline },
  );
  console.log(`  reply ${before + 1} in ${Date.now() - t0}ms`);
}
push("two model replies arrived", (await state()).assistants >= 2, { assistants: (await state()).assistants });

// ---- compact under zh ----
const label = (await state()).compactLabel;
push("compact button label is zh (压缩)", label === "压缩", { label });
const sysBefore = await sysItems();
const t1 = Date.now();
let zhText = null;
{
  await p.getByTestId("compact-btn").click();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const items = await sysItems();
    if (items.length > sysBefore.length) {
      zhText = items[items.length - 1];
      break;
    }
    await p.waitForTimeout(500);
  }
}
const zhMs = Date.now() - t1;
console.log("  zh notice after", zhMs, "ms:", zhText);
push(
  "zh compact notice with grouped tokens (US1)",
  zhText != null && /^上下文已压缩：[\d,]+ → [\d,]+ tokens。$/.test(zhText),
  { zhText, zhMs },
);
push("zh notice has no English residue", zhText != null && !zhText.includes("Context compacted"), { zhText });
push("zh notice has no missing-key marker", zhText != null && !zhText.includes("⟦"), { zhText });

// ---- switch to English ----
await p.getByTestId("options-btn").click();
await p.getByTestId("opt-language-en").click();
await p.waitForFunction(() => document.querySelector('[data-testid="tab-chat"]')?.textContent === "Chat", null, {
  timeout: 10000,
});
const enState = await state();
push("UI language is English (tab=Chat)", enState.tabChat === "Chat", { label: enState.compactLabel });
push("compact button label is en (Compact)", enState.compactLabel === "Compact", { label: enState.compactLabel });

// ---- compact under en ----
const sysMid = await sysItems();
const t2 = Date.now();
let enText = null;
{
  await p.getByTestId("compact-btn").click();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const items = await sysItems();
    if (items.length > sysMid.length) {
      enText = items[items.length - 1];
      break;
    }
    await p.waitForTimeout(500);
  }
}
const enMs = Date.now() - t2;
console.log("  en notice after", enMs, "ms:", enText);
push(
  "en compact notice verbatim pre-031 wording (US5)",
  enText != null && /^Context compacted: [\d,]+ → [\d,]+ tokens\.$/.test(enText),
  { enText, enMs },
);
push("en notice has no missing-key marker", enText != null && !enText.includes("⟦"), { enText });

// ---- the zh notice must survive the language switch untouched (FR-005) ----
const finalSys = await sysItems();
push(
  "earlier zh notice is not retranslated after switching to en (FR-005)",
  zhText != null && finalSys.some((t) => t === zhText),
  { zhText, finalCount: finalSys.length },
);

// ---- restore the initial language politely ----
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
};
const outDir = "../specs/031-compaction-i18n/evidence"; // relative to web/ (probe runs there for node_modules)
await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/probe-031-compaction.json`, JSON.stringify(verdict, null, 2));
console.log(`\n${pass}/${res.length} PASS — verdict → ${outDir}/probe-031-compaction.json`);
process.exit(pass === res.length ? 0 : 1);
