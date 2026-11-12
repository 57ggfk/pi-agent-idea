// 032 real-machine probe: the IDE environment snapshot lifecycle.
//
// Asserts, against the REAL WebStorm + REAL pi (CDP :9222):
//   1. the snapshot file exists after panel boot (pi-start first collection);
//   2. sending a message advances collectedAt (US4 freshness: the IDE
//      rewrites the snapshot before every prompt — no restart needed);
//   3. the extension stamped lastAppliedAt (injection receipt — proof the
//      block actually reached pi's system prompt, not just that pi replied);
//   4. pi answers normally with the extension loaded (behavioral);
//   5. WebStorm degradation (US5): no Java SDK tier, no error markers;
//   6. the manage-panel viewer shows the REAL snapshot.
//
// Usage: node probe-032-env.mjs <path-to-pi-ide-env.json>
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const SNAP = process.argv[2];
if (!SNAP) {
  console.error("usage: node probe-032-env.mjs <path-to-pi-ide-env.json>");
  process.exit(2);
}

const res = [];
const push = (n, ok, d) => {
  res.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} :: ${JSON.stringify(d).slice(0, 300)}`);
};
const readSnap = async () => JSON.parse(await readFile(SNAP, "utf8"));

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];
const redact = (u) => u.replace(/([?&]token=)[^&#]*/gi, "$1<redacted>");

await p.waitForSelector('[data-testid="tabs"]', { timeout: 20000 });

// 1. boot state
let snap = await readSnap();
push("snapshot file exists and is enabled", snap.enabled === true, { collectedAt: snap.collectedAt });
push("snapshot text is the rendered block", typeof snap.text === "string" && snap.text.includes("# IDE environment snapshot"), {});

// 2. one turn → refresh + receipt
await p.getByTestId("new-session").click();
await p.waitForTimeout(400);
if ((await p.locator('[data-testid="confirm-dialog"]').count()) > 0) await p.getByTestId("confirm-ok").click();
await p.waitForTimeout(600);
const before = await readSnap();
await p.getByTestId("composer-input").fill("032探针：请只回复收到");
await p.getByTestId("send-btn").click();
await p.waitForFunction(
  () =>
    document.querySelectorAll('[data-testid="item-assistant"]').length >= 1 &&
    !document.querySelector('[data-testid="status-dot"]')?.classList.contains("busy"),
  null,
  { timeout: 120_000 },
);
const after = await readSnap();
push("collectedAt advances with the turn (US4 freshness)", after.collectedAt > before.collectedAt, {
  before: before.collectedAt,
  after: after.collectedAt,
});
push(
  "extension stamped lastAppliedAt (injection receipt)",
  typeof after.lastAppliedAt === "string" && after.lastAppliedAt >= before.collectedAt,
  { lastAppliedAt: after.lastAppliedAt },
);
push("pi replied normally with the extension loaded", (await p.evaluate(() => document.querySelectorAll('[data-testid="item-assistant"]').length)) >= 1, {});

// 3. degradation on WebStorm (no Java SDK tier expected) — still sane text
push("WebStorm degrade: sources line renders, no error markers (US5)", after.text.includes("Sources present:") && !after.text.includes("⟦"), {
  sources: (after.text.match(/Sources present: (.*)/) ?? [])[1] ?? "",
});

// 4. the manage-panel viewer shows the REAL snapshot (not the mock body)
await p.getByTestId("tab-manage").click();
await p.getByTestId("manage-tab-settings").click();
await p.getByTestId("env-snapshot-btn").click();
await p.waitForSelector('[data-testid="env-snapshot-text"]', { timeout: 10000 });
const viewerText = await p.getByTestId("env-snapshot-text").textContent();
push(
  "panel viewer shows the real snapshot body",
  viewerText.includes("# IDE environment snapshot") && viewerText.includes(after.text.slice(0, 30)),
  {},
);
await p.getByTestId("tab-chat").click();

const pass = res.filter((r) => r.ok).length;
const verdict = {
  when: new Date().toISOString(),
  pageUrl: redact(p.url()),
  snapshotPath: SNAP,
  results: res,
  pass,
  total: res.length,
  snapshot: after,
};
await mkdir("../specs/032-ide-env-context/evidence", { recursive: true });
await writeFile("../specs/032-ide-env-context/evidence/probe-032-env.json", JSON.stringify(verdict, null, 2));
console.log(`\n${pass}/${res.length} PASS — verdict → specs/032-ide-env-context/evidence/probe-032-env.json`);
process.exit(pass === res.length ? 0 : 1);
