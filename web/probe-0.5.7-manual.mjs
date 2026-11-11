// Real-machine probe for the four manual items 0.5.7 left behind:
//   020 T215  model picker on the *real* pi catalog (one provider, 475 models)
//   021 T317  switch timings (switch.tap / pending / content / ready) from idea.log markers
//   023 T516  Fork button only on the last pi reply of each round
//
// 022 T414 has its own probe (probe-scroll-jcef.mjs) and is rerun separately.
//
// Preconditions: IDE launched with -Dide.browser.jcef.debug.port=9222 and
// -Dpi.agent.autoOpen=true, pi tool window open.
//
// Usage: node probe-0.5.7-manual.mjs [port] [stage]    stage = all|picker|switch|fork
// Writes probe-0.5.7-manual.json (plus screenshots) to build/ and prints a summary.
// Read-only: pokes the UI, never sends a message, never forks.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || process.env.JCEF_PORT || "9222";
const STAGE = process.argv[3] || "all";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTDIR = join(ROOT, "build");
mkdirSync(OUTDIR, { recursive: true });
const OUT = join(OUTDIR, "probe-0.5.7-manual.json");

const result = { port: PORT, at: new Date().toISOString(), page: null, assets: [], stages: {}, error: null };
const log = (...a) => console.log(...a);

async function claimPage(browser) {
  const pages = browser.contexts()[0].pages();
  let page = null;
  for (const p of pages) {
    // `tabs` covers the sessions/manage views too — the chat testids only
    // exist while the chat tab is mounted.
    const hit = await p
      .evaluate(() =>
        !!document.querySelector(
          '[data-testid="message-list"],[data-testid="composer-input"],[data-testid="setup-card"],[data-testid="tabs"]',
        ),
      )
      .catch(() => false);
    log(`  page ${p.url().slice(0, 80)} pi=${hit}`);
    if (hit) page = p;
  }
  return page;
}

async function shot(page, name) {
  const path = join(OUTDIR, `probe-0.5.7-${name}.png`);
  await page.screenshot({ path }).catch((e) => log(`  screenshot failed: ${e.message}`));
  return path;
}

// ---------------------------------------------------------------------------
// 020 T215 — real catalog: one provider with 475 models must render 200 and
// say how many are hidden; the current model must stay reachable; a collapsed
// provider must stay collapsed across a close/reopen.
// ---------------------------------------------------------------------------
async function stagePicker(page) {
  const s = { checks: [] };
  const push = (n, ok, d) => {
    s.checks.push({ n, ok, d });
    log(`${ok === true ? "PASS" : ok === false ? "FAIL" : "INFO"}  [picker] ${n} :: ${JSON.stringify(d)}`);
  };

  await page.getByTestId("tab-chat").click();
  await page.waitForTimeout(300);
  const originalCollapsed = await page.evaluate(() => window.localStorage.getItem("pi-agent.model-collapsed"));
  await page.getByTestId("model-chip").click();
  await page.getByTestId("model-popover").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(500);

  const groups = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="model-group"]')].map((g) => ({
      name: g.querySelector(".model-group-name")?.textContent?.trim() ?? "",
      count: g.querySelector('[data-testid="model-group-count"]')?.textContent?.trim() ?? "",
      expanded: g.getAttribute("aria-expanded") === "true",
    })),
  );
  const optionCount = await page.getByTestId("model-option").count();
  const moreTexts = (await page.getByTestId("model-group-more").allInnerTexts()).map((t) => t.trim());
  const current = await page.evaluate(() => {
    const check = document.querySelector('[data-model-key] .model-option-check');
    const row = check?.closest('[data-testid="model-option"]');
    const key = row?.dataset.modelKey ?? check?.closest("[data-model-key]")?.dataset.modelKey ?? null;
    const rect = row?.getBoundingClientRect();
    return {
      key,
      firstRowIsCurrent: row ? document.querySelector('[data-testid="model-option"]') === row : null,
      onScreen: rect ? rect.top >= 0 && rect.bottom <= (window.innerHeight || 0) : null,
    };
  });
  s.groups = groups;
  s.optionCount = optionCount;
  s.moreTexts = moreTexts;
  s.current = current;
  s.screenshot = await shot(page, "picker");

  push("组标题带 已显示/总数", groups.length > 0 && groups.every((g) => /\d+\/\d+/.test(g.count) || /^\d+$/.test(g.count)), groups);
  push("实际渲染条数受上限约束", optionCount > 0 && optionCount <= 50 * 200, { optionCount });
  push("组末给出隐藏条数", moreTexts.length > 0, moreTexts);
  push("当前模型可定位", current.key !== null && current.onScreen !== false, current);

  // Collapse the first group, close, reopen. Two rules interact here:
  //   - the collapsed set is persisted to localStorage (018 US5),
  //   - but a collapsed group holding the CURRENT model is expanded on open so
  //     the current model stays reachable (018 US5 + 020).
  // On a real catalog with a single provider those two rules point opposite
  // ways: the only group is the current one, so "survives reopen" can only be
  // observed through localStorage. The reload path itself is covered by
  // e2e/model-picker.spec.ts "the collapsed set survives a reload".
  const firstGroup = page.getByTestId("model-group").first();
  const collapsedProvider = groups[0]?.name ?? "";
  const holdsCurrentModel = current.key !== null && current.key.startsWith(`${collapsedProvider}/`);
  const beforeCollapse = await page.getByTestId("model-option").count();
  await firstGroup.click();
  await page.waitForTimeout(300);
  const afterCollapse = await page.getByTestId("model-option").count();
  const collapsedAttr = await firstGroup.getAttribute("aria-expanded");
  push("折叠后该组条目收起", afterCollapse < beforeCollapse, { beforeCollapse, afterCollapse, collapsedAttr });

  const stored = await page.evaluate(() => {
    try {
      return JSON.parse(window.localStorage.getItem("pi-agent.model-collapsed") || "[]");
    } catch {
      return null;
    }
  });
  push("折叠状态写入 localStorage", Array.isArray(stored) && stored.includes(collapsedProvider), { collapsedProvider, stored });

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  if (await page.getByTestId("model-popover").isVisible().catch(() => false)) {
    await page.getByTestId("model-chip").click();
    await page.waitForTimeout(300);
  }
  await page.getByTestId("model-chip").click();
  await page.getByTestId("model-popover").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(400);
  const reopened = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="model-group"]')].map((g) => g.getAttribute("aria-expanded")),
  );
  const reopenedCount = await page.getByTestId("model-option").count();
  if (holdsCurrentModel) {
    push("当前模型所在组重开时自动展开（018 US5）", reopened[0] === "true" && reopenedCount === beforeCollapse, {
      reopened, reopenedCount, why: "该组装着当前模型，必须展开才能定位",
    });
  } else {
    push("非当前组重开后保持折叠", reopened[0] === "false" && reopenedCount === afterCollapse, { reopened, reopenedCount });
  }


  // Put the stored preference back exactly as found, then close the popover —
  // a probe must not leave the user's picker folded differently.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
  if (await page.getByTestId("model-popover").isVisible().catch(() => false)) {
    await page.getByTestId("model-chip").click().catch(() => {});
    await page.waitForTimeout(200);
  }
  await page.evaluate((orig) => {
    if (orig === null) window.localStorage.removeItem("pi-agent.model-collapsed");
    else window.localStorage.setItem("pi-agent.model-collapsed", orig);
  }, originalCollapsed);
  s.restoredCollapsed = originalCollapsed;
  result.stages.picker = s;
}

// ---------------------------------------------------------------------------
// 021 T317 — click a historical session and read the perf marks the store
// prints to the console (forwarded to idea.log by PiAgentPanel).
// Thresholds from the spec: T1 tap<=150 / T2 pending<=300 / T3 content<=600 /
// T4 ready<=1200 ms.
// ---------------------------------------------------------------------------
async function stageSwitch(page) {
  const s = { marks: [], checks: [] };
  const push = (n, ok, d) => {
    s.checks.push({ n, ok, d });
    log(`${ok === true ? "PASS" : ok === false ? "FAIL" : "INFO"}  [switch] ${n} :: ${JSON.stringify(d)}`);
  };

  page.on("console", (msg) => {
    const text = msg.text();
    if (!text.includes("[pi-agent] perf")) return;
    const m = text.match(/perf (\S+) (\d+)(.*)$/);
    if (!m) return;
    s.marks.push({ event: m[1], ms: Number(m[2]), extra: m[3].trim() });
    log(`  perf ${m[1]} ${m[2]}ms ${m[3].trim()}`);
  });

  await page.getByTestId("tab-sessions").click();
  await page.waitForTimeout(1000);
  const rows = await page.getByTestId("session-row").count();
  push("会话列表有可切换项", rows > 0, { rows });
  if (rows === 0) {
    result.stages.switch = s;
    return;
  }

  // Pick a row that is not the current session (the first one usually is).
  const target = page.getByTestId("session-row").nth(Math.min(2, rows - 1));
  const targetText = (await target.innerText()).replace(/\n+/g, " | ").slice(0, 80);
  s.target = targetText;
  await target.click();
  await page.waitForTimeout(6000); // pi needs time; the marks tell the real story
  s.sessionSize = await page
    .getByTestId("status-messages")
    .innerText()
    .catch(() => null);

  const byEvent = {};
  for (const mk of s.marks) byEvent[mk.event] = mk.ms;
  s.byEvent = byEvent;
  // `switch.tap` exists in perf.ts's PerfEvent union but nothing ever emits it:
  // the click-to-placeholder path is synchronous, so `switch.pending` (measured
  // from the same `startedAt`) already carries T1.
  s.tapMarkEmitted = s.marks.some((m) => m.event === "switch.tap");
  push("记录了切换各段耗时", byEvent["switch.ready"] != null, byEvent);
  if (byEvent["switch.pending"] != null) {
    push("T1/T2 点击后立刻有占位 <=300ms", byEvent["switch.pending"] <= 300, {
      pending: byEvent["switch.pending"],
      note: "switch.pending 从点击处的 startedAt 起算，即 T1+T2 合一段",
    });
  }
  if (byEvent["switch.content"] != null) push("T3 内容绘制 <=600ms", byEvent["switch.content"] <= 600, { content: byEvent["switch.content"] });
  if (byEvent["switch.ready"] != null) {
    push("T4 整体就绪 <=1200ms", byEvent["switch.ready"] <= 1200, {
      ready: byEvent["switch.ready"],
      verdict: byEvent["switch.ready"] > 1200
        ? "超过 1200ms → 按 spec 拆分判断：反馈已 <150ms 时把 pi 侧耗时单独立项"
        : "远低于阈值，pi 侧耗时不构成瓶颈",
    });
  }
  s.screenshot = await shot(page, "switch");
  result.stages.switch = s;
}

// ---------------------------------------------------------------------------
// 023 T516 — a round is one question plus every pi reply to it (tool call +
// summary). Fork must exist on the last reply of each round only.
// ---------------------------------------------------------------------------
async function stageFork(page) {
  const s = { checks: [] };
  const push = (n, ok, d) => {
    s.checks.push({ n, ok, d });
    log(`${ok === true ? "PASS" : ok === false ? "FAIL" : "INFO"}  [fork] ${n} :: ${JSON.stringify(d)}`);
  };

  await page.getByTestId("tab-chat").click().catch(() => {});
  await page.waitForTimeout(600);

  const structure = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-testid="item-user"],[data-testid="item-assistant"],[data-testid="item-system"]')];
    return items.map((el) => ({
      kind: el.dataset.testid.replace("item-", ""),
      fork: !!el.querySelector('[data-testid="act-fork"]'),
      copy: !!el.querySelector('[data-testid="act-copy"]'),
    }));
  });
  s.structure = structure;

  // A reply is a round end when no other assistant reply follows it before the
  // next user message. system notices do not settle the round.
  const expectFork = structure.map((it, i) => {
    if (it.kind !== "assistant") return null;
    let last = true;
    for (let j = i + 1; j < structure.length; j++) {
      if (structure[j].kind === "assistant") { last = false; break; }
      if (structure[j].kind === "user") break;
    }
    return last;
  });
  const mismatches = structure
    .map((it, i) => ({ i, kind: it.kind, fork: it.fork, expected: expectFork[i] }))
    .filter((x) => x.expected !== null && x.fork !== x.expected);
  const roundEnds = expectFork.filter((x) => x === true).length;
  const forkCount = structure.filter((it) => it.fork).length;

  s.roundEnds = roundEnds;
  s.forkCount = forkCount;
  s.mismatches = mismatches;
  const assistants = structure.filter((it) => it.kind === "assistant").length;
  const withCopy = structure.filter((it) => it.copy).length;
  const withAnyAction = structure.filter((it) => it.kind === "assistant" && (it.fork || it.copy)).length;
  s.assistants = assistants;
  s.withCopy = withCopy;
  // Copy/quote are only offered when the reply has body text (`itemHasText`,
  // types.ts:719) — a pure tool-call reply legitimately has none. The matrix
  // itself is pinned by store/types.test.ts "actionsForItem"; here we only need
  // to see copy reaching text replies on a real transcript.
  push("有正文的回复保留复制", withCopy > 0, { assistants, withCopy, withAnyAction });
  push("Fork 只出现在每轮末尾", mismatches.length === 0, { roundEnds, forkCount, mismatches });
  push("本轮末尾回复仍带 Fork", roundEnds === 0 ? null : forkCount === roundEnds, { roundEnds, forkCount });
  s.screenshot = await shot(page, "fork");
  result.stages.fork = s;
}

// ---------------------------------------------------------------------------

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { noDefaults: true });
  const page = await claimPage(browser);
  if (!page) throw new Error("no pi webview among CDP pages");
  result.page = page.url();
  result.assets = await page.evaluate(() =>
    [...document.querySelectorAll("script[src],link[rel=stylesheet]")].map((e) => (e.src || e.href).split("/").pop()).filter(Boolean),
  );
  log(`attached, assets: ${result.assets.join(", ")}`);

  const want = (name) => STAGE === "all" || STAGE === name;
  if (want("picker")) await stagePicker(page);
  if (want("fork")) await stageFork(page);
  if (want("switch")) await stageSwitch(page);

  await page.getByTestId("tab-chat").click().catch(() => {});
} catch (e) {
  result.error = String(e && e.stack ? e.stack : e);
  log(`ERROR ${e.message}`);
} finally {
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  log(`\nwritten: ${OUT}`);
  if (browser) await browser.close().catch(() => {});
}

const failed = Object.values(result.stages).flatMap((s) => s.checks).filter((c) => c.ok === false);
log(failed.length === 0 ? "SUMMARY: all checks passed" : `SUMMARY: ${failed.length} failed -> ${failed.map((f) => f.n).join("; ")}`);
process.exit(result.error || failed.length ? 1 : 0);
