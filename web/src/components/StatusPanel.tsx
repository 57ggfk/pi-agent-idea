import { useMemo } from "react";
import { usePiStore } from "../store/store";
import { useT } from "../i18n/useT";
import { formatTokens } from "../store/types";
import {
  jobStepChain,
  mapJobState,
  outputEditsFromItems,
  todoSnapshotFromItems,
  type AsyncStatusSnapshot,
  type AsyncStatusSnapshotNode,
  type JobBadge,
  type SubagentRun,
  type TodoSnapshotItem,
} from "../store/types";
import { shortPath } from "../lib/shortPath";
import type { Dict } from "../i18n/locales/en";
import Icon from "./Icon";

/**
 * Status panel (specs/20261128-092912-status-panel, plan U1/U3): the chat
 * tab-tools popover with five read-only sections — run status / background
 * jobs / checklist / pending / output. Everything is a fold over existing
 * store state + the pure derivations in store/types.ts; the component never
 * re-derives and never mutates (FR-008: jump, don't operate).
 *
 * Geometry (FR-001) lives in styles.css: same anchor as the session outline
 * (top 40px / right 8px), width min(320px, 100cqw - 24px), max-height with an
 * internally scrolling body — .app only clips horizontally, so a tall panel
 * would be cut by the tool window's bottom edge.
 */

// Cursor tri-state glyphs (spec F-25): ○ not started · ◌ in progress · ✓ done
// (⊗ cancelled kept for the tolerated fourth state).
const TODO_GLYPHS: Record<TodoSnapshotItem["status"], string> = {
  pending: "○",
  active: "◌",
  done: "✓",
  cancelled: "⊗",
};

/** Chain-flow glyphs: done ✓ · running ● · waiting ◌ · failed ✗ · unknown ○. */
const CHAIN_GLYPHS: Record<JobBadge, string> = {
  done: "✓",
  running: "●",
  waiting: "◌",
  failed: "✗",
  unknown: "○",
};

const JOB_LABEL_KEYS: Record<JobBadge, keyof Dict> = {
  running: "panel.job.running",
  waiting: "panel.job.waiting",
  done: "panel.job.done",
  failed: "panel.job.failed",
  unknown: "panel.job.unknown",
};

const METHOD_LABEL_KEYS: Record<string, keyof Dict> = {
  confirm: "panel.method.confirm",
  select: "panel.method.select",
  input: "panel.method.input",
  editor: "panel.method.editor",
};

const RUN_STATE_LABEL_KEYS: Record<string, keyof Dict> = {
  idle: "panel.run.idle",
  streaming: "panel.run.streaming",
  starting: "panel.run.starting",
  exited: "panel.run.exited",
  notStarted: "panel.run.notStarted",
};

/**
 * Channel-D rows carry pi-subagents' own status vocabulary — completed |
 * failed | paused | stopped (extension-api.md:666) — which is NOT the
 * snapshot's eight-value set. Map them onto the panel's badge set; an
 * unknown status renders as "done" only when the extension says so, and
 * otherwise falls back to the neutral unknown badge.
 */
function mapSubagentStatus(status: string): JobBadge {
  switch (status.trim().toLowerCase()) {
    case "completed":
    case "complete":
    case "done":
      return "done";
    case "failed":
    case "error":
      return "failed";
    case "paused":
    case "waiting":
      return "waiting";
    case "stopped":
    case "rejected":
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      return status.trim() === "" ? "unknown" : "done";
  }
}

const SUBAGENT_STATUS_KEYS: Record<string, keyof Dict> = {
  running: "panel.job.running",
  waiting: "panel.job.waiting",
  done: "panel.job.done",
  failed: "panel.job.failed",
  unknown: "panel.job.unknown",
};

/** Stable empty list — see the subagentRuns selector below. */
const EMPTY_RUNS: SubagentRun[] = [];

/**
 * One background-job row (FR-011): job name + four-state badge + chain step
 * flow (`✓ scout → ● worker → ○ reviewer`) with a "step n/total" progress
 * while a step is running. The chain is rebuilt from the run node's children
 * through the same pure walker the snapshot uses; `partial` keeps its own
 * copy ("部分失败") per plan D2, and unknown wire states render verbatim
 * lowercase instead of being forced into a group.
 */
function JobRow({ run, snapshot }: { run: AsyncStatusSnapshotNode; snapshot: AsyncStatusSnapshot }) {
  const { t } = useT();
  const chain = useMemo(
    () => jobStepChain({ ...snapshot, runs: run.children ?? [] }),
    [snapshot, run],
  );
  const badge = mapJobState(run.state);
  const partial =
    badge === "failed" && typeof run.state === "string" && run.state.trim().toLowerCase() === "partial";
  const runningIdx = chain.steps.findIndex((step) => step.badge === "running");
  return (
    <div className="panel-job" data-testid="panel-job">
      <div className="panel-job-line">
        <span className="panel-job-name">{run.label || run.id}</span>
        {runningIdx >= 0 ? (
          <span className="panel-job-progress" data-testid="panel-job-progress">
            {t("panel.job.stepProgress", { n: runningIdx + 1, total: chain.steps.length })}
          </span>
        ) : null}
        <span className={`panel-badge job-${badge}`} data-testid="panel-job-badge">
          {partial ? t("panel.job.partial") : t(JOB_LABEL_KEYS[badge])}
        </span>
      </div>
      {chain.steps.length > 0 ? (
        <div className="panel-job-chain" data-testid="panel-job-chain">
          {chain.steps.map((step, i) => {
            // queued maps to the running badge, but in the step flow a step
            // that has not started yet stays an empty circle — the plan's
            // `✓ scout → ● worker → ○ reviewer` line only ever shows one ●.
            const upcoming = runningIdx >= 0 && i > runningIdx;
            return (
              <span
                key={`${step.label}-${i}`}
                className={`panel-chain-step ${upcoming ? "chain-upcoming" : `chain-${step.badge}`}`}
              >
                <span className="panel-chain-glyph" aria-hidden="true">
                  {upcoming ? "○" : CHAIN_GLYPHS[step.badge]}
                </span>{" "}
                {step.label}
                {i < chain.steps.length - 1 ? <span className="panel-chain-arrow">{" → "}</span> : null}
              </span>
            );
          })}
          {chain.truncated ? <span className="panel-chain-more">…</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export default function StatusPanel() {
  const open = usePiStore((s) => s.statusPanelOpen);
  const toggleStatusPanel = usePiStore((s) => s.toggleStatusPanel);
  const piStatus = usePiStore((s) => s.piStatus);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const model = usePiStore((s) => s.model);
  const stats = usePiStore((s) => s.stats);
  const extensionStatuses = usePiStore((s) => s.extensionStatuses);
  const subagentAsync = usePiStore((s) => s.subagentAsync);
  // FR-011 channel D: the runs recovered from the transcript.
  // A stable EMPTY constant matters: returning a fresh [] on every call makes
  // zustand see a changed value on every store update, and the panel renders
  // in an endless update loop.
  const subagentRuns = usePiStore((s) => (open ? s.subagentRuns : EMPTY_RUNS));
  const approvals = usePiStore((s) => s.approvals);
  // Closed panel → null, so streaming chunks do not re-render this component
  // at all. The derivations below are O(items×blocks) per transcript edit;
  // paying that while the panel is closed made the 30-round outline e2e
  // (transcript keeps growing mid-run) crawl on a slow box.
  const items = usePiStore((s) => (open ? s.items : null));
  const openOutput = usePiStore((s) => s.openOutput);
  const goToApproval = usePiStore((s) => s.goToApproval);
  const { t } = useT();

  // FR-006/FR-012: pure folds over the transcript — session switches rebuild
  // `items`, so per-session isolation holds by construction (FR-007).
  const todos = useMemo(() => (items ? todoSnapshotFromItems(items) : null), [items]);
  const outputs = useMemo(() => (items ? outputEditsFromItems(items) : []), [items]);

  if (!open || items === null) return null;

  // FR-002: same store fields as the status bar, synthesized identically.
  const runState: keyof typeof RUN_STATE_LABEL_KEYS =
    piStatus === "running" ? (isStreaming ? "streaming" : "idle") : piStatus;
  const percent = stats?.contextUsage?.percent;
  const ctxTokens = stats?.contextUsage?.tokens;
  const cost = stats?.cost;

  // US3-1: the in-progress item pins to the top; everything else keeps the
  // snapshot order.
  const activeTodos: TodoSnapshotItem[] = [];
  const restTodos: TodoSnapshotItem[] = [];
  for (const item of todos ?? []) (item.status === "active" ? activeTodos : restTodos).push(item);

  return (
    <div
      className="status-panel"
      data-testid="status-panel"
      role="dialog"
      aria-label={t("chat.statusPanel.label")}
    >
      <div className="outline-head">
        <span className="outline-title" data-testid="status-panel-title">
          {t("chat.statusPanel.title")}
        </span>
        <button
          type="button"
          className="outline-close"
          data-testid="status-panel-close"
          aria-label={t("chat.statusPanel.close")}
          onClick={() => toggleStatusPanel(false)}
        >
          <Icon name="x" className="ic-sm" />
        </button>
      </div>
      <div className="status-panel-body" data-testid="status-panel-body">
        {/* -- run status: always present (its four states carry the empty case) -- */}
        <section className="panel-section" data-testid="panel-run">
          <div className="panel-section-title">{t("panel.section.run")}</div>
          <div className="panel-row">
            <span className={`status-dot ${piStatus} ${isStreaming ? "busy" : ""}`} />
            <span className="panel-run-state" data-testid="panel-run-state">
              {t(RUN_STATE_LABEL_KEYS[runState])}
            </span>
          </div>
          {model ? (
            <div className="panel-row" data-testid="panel-run-model">
              <span className="panel-row-key">{t("panel.run.model")}</span>
              <span className="panel-row-val">{model.name ?? model.id}</span>
            </div>
          ) : null}
          {percent != null ? (
            <div className="panel-row" data-testid="panel-run-ctx">
              <span className="panel-row-key">{t("panel.run.context")}</span>
              {/* The row already labels this "上下文" — the value must not
                  repeat the word (status.ctx carries its own prefix for the
                  status bar, which has no label column). */}
              <span className="panel-row-val">
                {t("panel.run.contextValue", { pct: Math.round(percent) })}
                {ctxTokens != null ? ` · ${formatTokens(ctxTokens)}` : ""}
              </span>
            </div>
          ) : null}
          {cost != null ? (
            <div className="panel-row" data-testid="panel-run-cost">
              <span className="panel-row-key">{t("panel.run.cost")}</span>
              <span className="panel-row-val">${cost.toFixed(4)}</span>
            </div>
          ) : null}
          {piStatus === "exited" ? (
            // FR-008: a pointer, not a second restart button.
            <div className="panel-note" data-testid="panel-run-exit-hint">
              {t("panel.run.exitHint")}
            </div>
          ) : null}
          {extensionStatuses.map((entry) => (
            <div className="panel-row" key={entry.statusKey} data-testid="panel-ext-status">
              <span className="panel-ext-key">{entry.statusKey}</span>
              <span className="panel-ext-text">{entry.text}</span>
            </div>
          ))}
        </section>

        {/* -- background jobs: hidden until pi-subagents registers its widget
               (channel A, probe-036 §4); installed-but-empty shows the empty
               state instead of hiding (US5-3 / plan U3). -- */}
        {subagentAsync.seen ? (
          <section className="panel-section" data-testid="panel-jobs">
            <div className="panel-section-title">{t("panel.section.jobs")}</div>
            {subagentAsync.snapshot === null ? (
              <div className="panel-note" data-testid="panel-jobs-empty">
                {t("panel.jobs.empty")}
              </div>
            ) : (
              <>
                {subagentAsync.snapshot.runs.map((run) => (
                  <JobRow key={run.id} run={run} snapshot={subagentAsync.snapshot!} />
                ))}
                {jobStepChain(subagentAsync.snapshot).truncated ? (
                  <div className="panel-note">{t("panel.jobs.truncated")}</div>
                ) : null}
              </>
            )}
          </section>
        ) : null}

        {/* -- sub-agents: the individual runs, recovered from the transcript
               (FR-011 channel D). Kept apart from 后台任务 on purpose: the
               jobs section answers "what is running right now", this one
               answers "what sub-agents did this session use". -- */}
        {subagentRuns.length > 0 ? (
          <section className="panel-section" data-testid="panel-subagents">
            <div className="panel-section-title">{t("panel.section.subagents")}</div>
            {subagentRuns.map((run, i) => (
              <div
                key={run.runId || `${run.agent}-${i}`}
                className="panel-subagent"
                data-testid="panel-subagent"
                data-origin={run.origin}
              >
                <span className="panel-subagent-name">{run.agent || t("panel.subagent.unnamed")}</span>
                <span
                  className={`panel-badge job-${mapSubagentStatus(run.status)}`}
                  data-testid="panel-subagent-badge"
                >
                  {t(SUBAGENT_STATUS_KEYS[mapSubagentStatus(run.status)] ?? "panel.job.done")}
                </span>
              </div>
            ))}
          </section>
        ) : null}

        {/* -- checklist: hidden with no todo snapshot at all (FR-012) -- */}
        {todos !== null ? (
          <section className="panel-section" data-testid="panel-todo">
            <div className="panel-section-title">{t("panel.section.todo")}</div>
            {[...activeTodos, ...restTodos].map((item, i) => (
              <div
                key={`${item.text}-${i}`}
                className={`panel-todo-item todo-${item.status}`}
                data-testid="panel-todo-item"
                data-status={item.status}
              >
                <span className="panel-todo-glyph" aria-hidden="true">
                  {TODO_GLYPHS[item.status]}
                </span>
                <span className="panel-todo-text">{item.text}</span>
              </div>
            ))}
          </section>
        ) : null}

        {/* -- pending: mirrors `approvals`; hidden when nothing is waiting -- */}
        {approvals.length > 0 ? (
          <section className="panel-section" data-testid="panel-pending">
            <div className="panel-section-title">{t("panel.section.pending")}</div>
            <div className="panel-note" data-testid="panel-pending-count">
              {t("panel.pending.count", { n: approvals.length })}
            </div>
            {approvals.map((a) => (
              <button
                key={a.id}
                type="button"
                className="panel-row-btn"
                data-testid="panel-pending-item"
                onClick={() => void goToApproval()}
              >
                <span className="panel-badge" data-testid="panel-pending-method">
                  {t(METHOD_LABEL_KEYS[a.method])}
                </span>
                <span className="panel-item-text">{a.title || a.message}</span>
              </button>
            ))}
          </section>
        ) : null}

        {/* -- output: always present; empty state is specced, not a blank (US4-4) -- */}
        <section className="panel-section" data-testid="panel-output">
          <div className="panel-section-title">{t("panel.section.output")}</div>
          {outputs.length === 0 ? (
            <div className="panel-note" data-testid="panel-output-empty">
              {t("panel.output.empty")}
            </div>
          ) : (
            outputs.map((o) => (
              <button
                key={o.path}
                type="button"
                className="panel-row-btn"
                data-testid="panel-output-item"
                title={o.path}
                onClick={() => void openOutput(o.path)}
              >
                <span className="panel-item-text" data-testid="panel-output-path">
                  {shortPath(o.path)}
                </span>
                {o.kinds.map((kind) => (
                  <span key={kind} className="panel-badge" data-testid="panel-output-kind">
                    {kind === "write" ? t("panel.output.kindWrite") : t("panel.output.kindEdit")}
                  </span>
                ))}
                {o.count > 1 ? (
                  <span className="panel-times" data-testid="panel-output-times">
                    {t("panel.output.times", { n: o.count })}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
