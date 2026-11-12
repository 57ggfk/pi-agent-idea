// 024 real-machine part 3 (v2): rows carry the session file in their `title`
// attribute, so we can address a specific row instead of guessing from text.
// The fork suffix rule only fires for a NAMED parent — an unnamed parent is
// left unnamed on purpose so pi's auto-titler can name the fork. This probe
// forks a named non-current row, checks "<name>（分支）" appears, then deletes
// exactly the rows it created (file-set diff).
import { chromium } from "@playwright/test";

const res = [];
const push = (n, ok, d) => {
  res.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} :: ${JSON.stringify(d)}`);
};

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];
const token = new URL(p.url()).searchParams.get("token");

const listRaw = async () => {
  const rec = await p.evaluate(async (tk) => {
    const base = location.origin;
    const id = `probe-${Math.random().toString(36).slice(2)}`;
    await fetch(`${base}/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Token": tk },
      body: JSON.stringify({ t: "sessions.list", id, p: {} }),
    });
    const deadline = Date.now() + 20000;
    let cursor = 0;
    while (Date.now() < deadline) {
      const r = await fetch(`${base}/bridge/poll?cursor=${cursor}&timeout=4000`, { headers: { "X-Pi-Token": tk } });
      const d = await r.json();
      cursor = d.cursor;
      for (const e of d.events ?? []) if (e.record?.t === "resp" && e.record?.id === id) return e.record;
    }
    return null;
  }, token);
  return rec?.data?.sessions ?? [];
};

const domState = () =>
  p.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="session-row"]')];
    const cur = document.querySelector('[data-testid="session-row"].session-current');
    return {
      count: rows.length,
      files: rows.map((r) => r.getAttribute("title")),
      labels: rows.map((r) => r.getAttribute("title") + " ⇒ " + r.querySelector(".session-name")?.textContent?.trim()),
      currentFile: cur?.getAttribute("title") ?? null,
      onChat: !!document.querySelector('[data-testid="message-list"]'),
    };
  });

await p.getByTestId("tab-sessions").click();
await p.waitForSelector('[data-testid="session-row"]', { timeout: 15000 });
await p.waitForTimeout(300);

const before = await domState();
const sessionsBefore = await listRaw();
const currentId = before.currentFile?.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];

const target = sessionsBefore.find(
  (s) => s.name && !s.name.endsWith("（分支）") && !s.file.includes(currentId ?? "\u0000"),
);
console.log("target:", JSON.stringify({ file: target?.file?.split("\\").pop(), name: target?.name }));
if (!target) throw new Error("no named non-current session to fork");

push("target row present in the DOM", before.files.includes(target.file), { file: target.file.split("\\").pop() });

await p.locator(`[data-testid="session-row"][title="${target.file.replace(/\\/g, "\\\\")}"]`).getByTestId("session-fork").click();

let after = before;
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  await p.waitForTimeout(700);
  after = await domState();
  if (after.count > before.count) break;
}

push("fork row created", after.count === before.count + 1, { before: before.count, after: after.count });
const addedFiles = after.files.filter((f) => !before.files.includes(f));
const wanted = `${target.name}（分支）`;
const addedLabels = after.labels.filter((l) => addedFiles.some((f) => l.startsWith(f + " ⇒ ")));
push("new row is named '<parent>（分支）'", addedLabels.some((l) => l.endsWith("⇒ " + wanted)), { addedLabels, wanted });
push("live session untouched", after.currentFile === before.currentFile, {
  before: before.currentFile?.split("\\").pop(),
  after: after.currentFile?.split("\\").pop(),
});
push("did not jump to chat", after.onChat === false);
await p.screenshot({ path: "../build/probe-024-real-fork-named.png" }).catch(() => {});

// ---- cleanup: delete exactly the files this probe added ----
for (const f of addedFiles) {
  const row = p.locator(`[data-testid="session-row"][title="${f.replace(/\\/g, "\\\\")}"]`);
  if ((await row.count()) === 0) {
    console.log("  cleanup skip (row gone):", f.split("\\").pop());
    continue;
  }
  await row.getByTestId("session-delete").click();
  await p.waitForSelector('[data-testid="confirm-dialog"]', { timeout: 5000 });
  await p.getByTestId("confirm-ok").click();
  await p.waitForTimeout(1500);
  console.log("  deleted:", f.split("\\").pop());
}
await p.waitForTimeout(800);
const final = await domState();
push("cleanup restored the row count", final.count === before.count, { before: before.count, final: final.count });

console.log("\nsummary: " + res.filter((r) => r.ok).length + "/" + res.length + " pass");
await b.close();
