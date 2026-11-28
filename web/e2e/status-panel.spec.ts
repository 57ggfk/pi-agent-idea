import { expect, test, type Page } from "@playwright/test";

/**
 * Status panel (specs/20261128-092912-status-panel) — FR-001 entry/geometry/
 * exclusivity, FR-002 run status, FR-004 pending, FR-006/007 output, FR-009
 * i18n, FR-010 narrow-viewport geometry, FR-011 background jobs, FR-012
 * checklist. Constitution II: every assertion that claims visibility or
 * layout carries geometry or behavior, not just toBeVisible.
 */

async function sendAndWait(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await expect(page.getByTestId("status-dot")).not.toHaveClass(/busy/, { timeout: 30_000 });
}

async function openPanel(page: Page) {
  await page.getByTestId("status-panel-btn").click();
  await expect(page.getByTestId("status-panel")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
});

test("the status button exists on chat, carries no badge, and toggles the panel (FR-001)", async ({ page }) => {
  const btn = page.getByTestId("status-panel-btn");
  // Always there, even in an empty session (unlike the outline entry).
  await expect(btn).toBeVisible();
  // No badge (D-1 拍板): the button face is icon + short label only — no digits.
  const label = await btn.innerText();
  expect(label).not.toMatch(/\d/);

  await btn.click();
  const panel = page.getByTestId("status-panel");
  await expect(panel).toBeVisible();
  // Behavior, not just visibility: the button toggles — a second click closes.
  await btn.click();
  await expect(panel).toHaveCount(0);
});

test("default scene: run status and output sections show; jobs/todo/pending hide (US3-3/US4-4/US5-3)", async ({ page }) => {
  await openPanel(page);
  const panel = page.getByTestId("status-panel");

  // Run status is always present; an un-started mock bridge reports 未启动/Not started.
  await expect(panel.getByTestId("panel-run-state")).toHaveText(/Not started|未启动/);
  // A session with no write calls shows the explicit empty state, not a blank.
  await expect(panel.getByTestId("panel-output-empty")).toBeVisible();
  // pi-subagents never registered (no setWidget frame) → whole section hidden.
  await expect(panel.getByTestId("panel-jobs")).toHaveCount(0);
  // No todo toolcall in the transcript → whole section hidden (FR-012).
  await expect(panel.getByTestId("panel-todo")).toHaveCount(0);
  // No pending approvals → whole section hidden.
  await expect(panel.getByTestId("panel-pending")).toHaveCount(0);
});

test("the popover sits at the outline anchor: top 40px, right 8px, width ≤ 320px (FR-001)", async ({ page }) => {
  await openPanel(page);
  const panel = page.getByTestId("status-panel");
  const pr = await panel.boundingBox();
  const ar = await page.locator(".app").boundingBox();
  expect(pr).not.toBeNull();
  expect(ar).not.toBeNull();
  // top: 40px below the app's top edge.
  expect(Math.abs(pr!.y - (ar!.y + 40))).toBeLessThanOrEqual(1);
  // right: 8px gap to the app's right edge.
  expect(Math.abs(ar!.x + ar!.width - (pr!.x + pr!.width) - 8)).toBeLessThanOrEqual(1);
  // width: min(320px, 100cqw - 24px) — capped at 320 on the default viewport.
  expect(pr!.width).toBeLessThanOrEqual(320.5);
  // The right edge never leaves the tool window.
  expect(pr!.x + pr!.width).toBeLessThanOrEqual(ar!.x + ar!.width + 0.5);
});

test("US1-1: idle run shows Idle + model + context + cost, same store fields as the status bar", async ({ page }) => {
  await page.goto("/?pistate=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  // pi reports running ~300ms after boot; wait for it like the status bar does.
  await expect(page.getByTestId("status-dot")).toHaveClass(/running/, { timeout: 10_000 });
  await openPanel(page);
  await expect(page.getByTestId("panel-run-state")).toHaveText("Idle");
  // Same-source data (FR-002): the model the status bar would show.
  await expect(page.getByTestId("panel-run-model")).toContainText("Mock Model Pro");
  // Context row carries the percentage (mock reports 9%) — the value itself,
  // not just a label.
  await expect(page.getByTestId("panel-run-ctx")).toContainText(/9\s*%/);
  await expect(page.getByTestId("panel-run-ctx")).toContainText(/18[.,]?/); // 18080 tokens ≈ 18.1k
  // The row already says "Context"/"上下文" — the value must not repeat the
  // word (real-machine finding 2026-11-28: it rendered "上下文  上下文 0% · 0").
  const ctxText = await page.getByTestId("panel-run-ctx").innerText();
  expect(ctxText.toLowerCase().match(/context|上下文/g)?.length ?? 0).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("panel-run-cost")).toContainText("$");
});

test("US1-2: the run state flips to Generating within 2s of streaming (FR-002)", async ({ page }) => {
  await page.goto("/?pistate=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("streaming probe");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/, { timeout: 20_000 });
  await openPanel(page);
  // The mock's first chunk lands ~150ms after agent_start; the panel must show
  // the synthesized streaming state while the dot is still busy.
  await expect(page.getByTestId("panel-run-state")).toHaveText("Generating", { timeout: 2_000 });
  await expect(page.getByTestId("status-dot")).toHaveClass(/busy/);
});

test("US1-3: exited pi shows Exited + the status-bar hint and no restart button (FR-002/FR-008)", async ({ page }) => {
  await page.goto("/?pistate=exited");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await openPanel(page);
  await expect(page.getByTestId("panel-run-state")).toHaveText(/Exited|已退出/, { timeout: 10_000 });
  await expect(page.getByTestId("panel-run-exit-hint")).toBeVisible();
  // FR-008: the panel only points at the status bar — the restart action
  // stays there (the restart button exists on the status bar, never in the panel).
  await expect(page.getByTestId("status-panel").getByTestId("restart-btn")).toHaveCount(0);
  await expect(page.getByTestId("restart-btn")).toHaveCount(1);
});

test("US1-4: a setStatus entry appears while set and disappears when cleared (FR-003)", async ({ page }) => {
  await page.goto("/?panel=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("status entry probe");
  await page.getByTestId("send-btn").click();
  await openPanel(page);

  const entry = page.getByTestId("panel-ext-status");
  await expect(entry).toContainText("mock-indexer");
  await expect(entry).toContainText("Indexing project files…");
  // The extension clears the same statusKey later in the run — the entry goes.
  await expect(entry).toHaveCount(0, { timeout: 20_000 });
});

test("US2: pending count, title summary, confirm badge, click jumps to the card, answering zeroes it (FR-004)", async ({ page }) => {
  await page.goto("/?approval=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("pending probe");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("approval-card")).toBeVisible();

  await openPanel(page);
  await expect(page.getByTestId("panel-pending-count")).toHaveText(/1/);
  const entry = page.getByTestId("panel-pending-item").first();
  await expect(entry).toContainText("Allow bash?");
  await expect(entry.getByTestId("panel-pending-method")).toHaveText("confirm");

  // Behavior: click → back to the chat tab, the queue-head card flashed and
  // inside the viewport (geometry, constitution II).
  const viewport = page.viewportSize()!;
  await entry.click();
  await expect(page.getByTestId("tab-chat")).toHaveAttribute("aria-selected", "true");
  const card = page.getByTestId("approval-card");
  await expect(card).toHaveClass(/flash-target/);
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);

  // Answer the head card; the mirror empties and the section hides (US2-3).
  await page.getByTestId("approval-allow").click();
  await expect(page.getByTestId("panel-pending")).toHaveCount(0, { timeout: 30_000 });
});

test("US2-4: dialog kinds are distinguishable — a select shows the select badge", async ({ page }) => {
  await page.goto("/?dialog=select");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("composer-input").fill("dialog kind probe");
  await page.getByTestId("send-btn").click();
  await expect(page.getByTestId("approval-card")).toBeVisible();

  await openPanel(page);
  await expect(page.getByTestId("panel-pending-count")).toHaveText(/1/);
  await expect(page.getByTestId("panel-pending-item").first().getByTestId("panel-pending-method")).toHaveText("select");
});

test("US3: checklist renders the Cursor tri-state with active first and highlighted (FR-012)", async ({ page }) => {
  await page.goto("/?panel=todo");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await sendAndWait(page, "checklist probe");
  await openPanel(page);

  const items = page.getByTestId("panel-todo-item");
  await expect(items).toHaveCount(5); // 2 ✓ 1 ◌ 2 ○
  // Active item is pinned to the top, dashed-circle glyph, highlighted.
  const first = items.nth(0);
  await expect(first).toHaveClass(/todo-active/);
  await expect(first).toContainText("Wire the telemetry hook");
  await expect(first.locator(".panel-todo-glyph")).toHaveText("◌");
  // The snapshot order holds behind the pinned active item: the two done
  // first, then the two pending (2✓ 2○).
  await expect(items.nth(1).locator(".panel-todo-glyph")).toHaveText("✓");
  await expect(items.nth(1)).toContainText("Ship the login flow");
  await expect(items.nth(2).locator(".panel-todo-glyph")).toHaveText("✓");
  await expect(items.nth(3).locator(".panel-todo-glyph")).toHaveText("○");
  await expect(items.nth(4).locator(".panel-todo-glyph")).toHaveText("○");
  // Class-driven tri-state is countable: exactly 2 done, 2 pending, 1 active.
  await expect(page.locator('[data-testid="panel-todo-item"].todo-done')).toHaveCount(2);
  await expect(page.locator('[data-testid="panel-todo-item"].todo-pending')).toHaveCount(2);
});

test("US4: output dedupes 3 paths (one edited twice), badges kinds, click opens the IDE diff (FR-006)", async ({ page }) => {
  await page.goto("/?panel=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await sendAndWait(page, "output probe");
  await openPanel(page);

  const items = page.getByTestId("panel-output-item");
  await expect(items).toHaveCount(3);
  // First-appearance order: the scripted default edit lands first.
  await expect(items.nth(0).getByTestId("panel-output-path")).toHaveText("src/main.tsx");
  await expect(items.nth(1).getByTestId("panel-output-path")).toHaveText("src/feature.ts");
  await expect(items.nth(2).getByTestId("panel-output-path")).toHaveText("src/lib/util.ts");
  // Change kinds: write → New/rewrite; edit → Edited; the twice-edited file
  // shows the ×2 counter.
  await expect(items.nth(0).getByTestId("panel-output-kind")).toHaveText("Edited");
  await expect(items.nth(1).getByTestId("panel-output-kind")).toHaveText("New/rewrite");
  await expect(items.nth(2).getByTestId("panel-output-kind")).toHaveText("Edited");
  await expect(items.nth(2).getByTestId("panel-output-times")).toHaveText(/×\s*2/);

  // Behavior: the click hands the exact path to the IDE diff bridge.
  await items.nth(2).click();
  const diffed = await page.evaluate(() => sessionStorage.getItem("pi-mock-show-file-diff"));
  expect(diffed).toBe("src/lib/util.ts");
  const opened = await page.evaluate(() => sessionStorage.getItem("pi-mock-open-file"));
  expect(opened).toBeNull();
});

test("US4: a refused diff falls back to opening the file (FR-006 fallback)", async ({ page }) => {
  await page.goto("/?panel=1&showFileDiff=fail");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await sendAndWait(page, "diff fallback probe");
  await openPanel(page);
  const items = page.getByTestId("panel-output-item");
  await expect(items).toHaveCount(3);
  await items.nth(2).click();
  const opened = await page.evaluate(() => sessionStorage.getItem("pi-mock-open-file"));
  expect(opened).toBe("src/lib/util.ts");
  const diffed = await page.evaluate(() => sessionStorage.getItem("pi-mock-show-file-diff"));
  expect(diffed).toBeNull();
});

test("US4-3/FR-007: a new session recomputes the output section from zero", async ({ page }) => {
  await page.goto("/?panel=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await sendAndWait(page, "session isolation probe");
  await openPanel(page);
  await expect(page.getByTestId("panel-output-item")).toHaveCount(3);

  await page.getByTestId("new-session").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("empty-state")).toBeVisible();
  // Same panel, still open (U2: session switches do not close it), now empty.
  await expect(page.getByTestId("status-panel")).toBeVisible();
  await expect(page.getByTestId("panel-output-empty")).toBeVisible();
  await expect(page.getByTestId("panel-output-item")).toHaveCount(0);
});

test("FR-011: jobs section registers, shows the running chain 2/3, then the completed job; a session switch resets the snapshot", async ({ page }) => {
  await page.goto("/?panel=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await openPanel(page);
  const jobs = page.getByTestId("panel-jobs");
  // Before any frame the section is hidden — the extension has not registered.
  await expect(jobs).toHaveCount(0);

  await page.getByTestId("composer-input").fill("jobs probe");
  await page.getByTestId("send-btn").click();

  // Frame 1 — the empty registration frame: installed but no jobs.
  await expect(jobs).toBeVisible();
  await expect(page.getByTestId("panel-jobs-empty")).toBeVisible();

  // Frame 2 — one chain job running at step 2/3: name, badge, progress, flow.
  await expect(page.getByTestId("panel-job")).toHaveCount(1, { timeout: 10_000 });
  const chainJob = page.getByTestId("panel-job").first();
  await expect(chainJob).toContainText("refactor-auth");
  await expect(chainJob.getByTestId("panel-job-badge")).toHaveText("Running");
  await expect(chainJob.getByTestId("panel-job-progress")).toHaveText(/2\s*\/\s*3/);
  await expect(chainJob.getByTestId("panel-job-chain")).toContainText("✓ scout");
  await expect(chainJob.getByTestId("panel-job-chain")).toContainText("● worker");
  await expect(chainJob.getByTestId("panel-job-chain")).toContainText("○ reviewer");

  // Frame 3 — a completed job joins; the chain keeps running 2/3.
  await expect(page.getByTestId("panel-job")).toHaveCount(2, { timeout: 10_000 });
  const doneJob = page.getByTestId("panel-job").filter({ hasText: "docs-sync" });
  await expect(doneJob.getByTestId("panel-job-badge")).toHaveText("Completed");
  await expect(page.getByTestId("panel-job").filter({ hasText: "refactor-auth" }).getByTestId("panel-job-badge")).toHaveText("Running");

  // Session switch: the panel stays open (U2) but the old snapshot must not
  // leak — the section falls back to the installed-but-empty state (D2 reset).
  await page.getByTestId("new-session").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.getByTestId("status-panel")).toBeVisible();
  await expect(page.getByTestId("panel-jobs")).toBeVisible();
  await expect(page.getByTestId("panel-jobs-empty")).toBeVisible();
  await expect(page.getByTestId("panel-job")).toHaveCount(0);
});

test("FR-011 channel D: sub-agents recovered from the transcript get their own section", async ({ page }) => {
  await page.goto("/?panel=1");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await openPanel(page);

  // Before the run there are no sub-agent records at all.
  await expect(page.getByTestId("panel-subagents")).toHaveCount(0);

  // The run produces two background runs and one foreground run — pi
  // delivers them as events (mock fixture in bridge/mock.ts, pi-subagents'
  // own shapes).
  await page.getByTestId("composer-input").fill("subagent probe");
  await page.getByTestId("send-btn").click();

  const subagents = page.getByTestId("panel-subagents");
  await expect(subagents).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("panel-subagent")).toHaveCount(3);

  // Each row names its agent and carries a state badge.
  await expect(page.getByTestId("panel-subagent").filter({ hasText: "worker" })).toBeVisible();
  await expect(page.getByTestId("panel-subagent").filter({ hasText: "scout" })).toBeVisible();
  await expect(page.getByTestId("panel-subagent").filter({ hasText: "reviewer" })).toBeVisible();
  await expect(
    page.getByTestId("panel-subagent").filter({ hasText: "worker" }).getByTestId("panel-subagent-badge"),
  ).toHaveText("Completed");
  await expect(
    page.getByTestId("panel-subagent").filter({ hasText: "scout" }).getByTestId("panel-subagent-badge"),
  ).toHaveText("Failed");

  // The sub-agent section is its own category — it must not be folded into
  // the background-jobs rows (the user's ask on the real machine).
  await expect(subagents).toContainText("Sub-agents");
});

test("FR-001: the three popovers are mutually exclusive with the status panel", async ({ page }) => {
  await sendAndWait(page, "exclusivity probe");
  const panel = page.getByTestId("status-panel");

  await openPanel(page);
  await page.getByTestId("outline-btn").click();
  await expect(page.getByTestId("session-outline")).toBeVisible();
  await expect(panel).toHaveCount(0);

  await openPanel(page);
  await expect(page.getByTestId("session-outline")).toHaveCount(0);
  await page.getByTestId("search-btn").click();
  await expect(page.getByTestId("search-bar")).toBeVisible();
  await expect(panel).toHaveCount(0);

  await openPanel(page);
  await expect(page.getByTestId("search-bar")).toHaveCount(0);
});

test("FR-010: at 360px the panel never causes horizontal overflow and stays inside the app", async ({ page }) => {
  await page.goto("/?panel=todo");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.setViewportSize({ width: 360, height: 760 });
  await sendAndWait(page, "narrow geometry probe");
  await openPanel(page);

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
  const panel = page.getByTestId("status-panel");
  const pr = await panel.boundingBox();
  const ar = await page.locator(".app").boundingBox();
  expect(pr).not.toBeNull();
  expect(ar).not.toBeNull();
  // 100cqw - 24px = 336px at 360 → width caps at min(320, 336) = 320.
  expect(pr!.width).toBeLessThanOrEqual(320.5);
  expect(Math.abs(ar!.x + ar!.width - (pr!.x + pr!.width) - 8)).toBeLessThanOrEqual(1);
  expect(pr!.x).toBeGreaterThanOrEqual(ar!.x - 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});

test("FR-010/plan U6: in a short viewport the panel caps at max-height and scrolls inside (not the window)", async ({ page }) => {
  await page.goto("/?panel=todo");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.setViewportSize({ width: 480, height: 600 });
  await sendAndWait(page, "short viewport probe");
  await openPanel(page);

  const panel = page.getByTestId("status-panel");
  const pr = await panel.boundingBox();
  const ar = await page.locator(".app").boundingBox();
  expect(pr).not.toBeNull();
  expect(ar).not.toBeNull();
  // max-height: min(60vh, 420px) = 360px at 600 — the panel bottom must stay
  // inside the app, and the content scrolls within the panel body.
  expect(pr!.height).toBeLessThanOrEqual(360.5);
  expect(pr!.y + pr!.height).toBeLessThanOrEqual(ar!.y + ar!.height + 0.5);
  const body = page.getByTestId("status-panel-body");
  const overflow = await body.evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
  }));
  expect(overflow.scroll).toBeGreaterThan(overflow.client); // internal scroll engaged
  // The window itself gains no scrollbars from the panel.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});

test("FR-009: the panel chrome translates — switching to Chinese relabels sections live", async ({ page }) => {
  await sendAndWait(page, "i18n probe");
  await openPanel(page);
  const panel = page.getByTestId("status-panel");
  await expect(panel).toContainText("Run status");
  await expect(panel).toContainText("Output");

  await page.getByTestId("options-btn").click();
  await page.getByTestId("opt-language-zh").click();
  await expect(page.getByTestId("tab-chat")).toHaveText("聊天");
  await expect(page.getByTestId("status-panel")).toBeVisible();
  await expect(page.getByTestId("status-panel")).toContainText("运行状态");
  await expect(page.getByTestId("status-panel")).toContainText("产出");
  const cjk = await page.getByTestId("status-panel").evaluate((el) => /[\u4e00-\u9fa5]/.test(el.textContent ?? ""));
  expect(cjk).toBe(true);
});
