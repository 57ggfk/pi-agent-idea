import { useCallback, useEffect, useState } from "react";
import { usePiStore } from "../../store/store";
import type { Bridge } from "../../bridge/types";
import { manageApi, type EnvUpdateResult, type EnvironmentResult, type ToolStatus } from "../../manage";
import { useT } from "../../i18n/useT";
import { shortPath } from "../../lib/shortPath";
import {
  SOURCE_IDS,
  SOURCE_LABELS,
  summarize,
  summarizeState,
  type SourceId,
  type SourceStatus,
} from "../../store/sources";

const STATUS_LABEL: Record<SourceStatus, string> = {
  ready: "Ready",
  loading: "Loading",
  failed: "Failed",
  unsupported: "Not supported",
  idle: "Not loaded",
};

/**
 * One tool line in the environment card (036 FR-001/FR-002): `node vX.Y.Z`
 * plus its path — full path on wide panels, `~/`-shortened on narrow ones
 * (the shared .skill-path-* CSS switch). A missing tool is an explicit
 * "not found", never a blank.
 */
function ToolLine({ label, tool, homeDir, testid }: { label: string; tool?: ToolStatus; homeDir?: string; testid: string }) {
  const { t } = useT();
  return (
    <span className="diag-env-row" data-testid={testid}>
      <span className="diag-env-label">{label}</span>
      {tool?.found ? (
        <>
          <b data-testid={`${testid}-version`}>{tool.version || t("manage.env.unknown")}</b>
          <span className="diag-env-path mono">
            <span className="skill-path-full" data-testid={`${testid}-path-full`}>{tool.path}</span>
            <span className="skill-path-short" data-testid={`${testid}-path-short`}>{shortPath(tool.path, homeDir)}</span>
          </span>
        </>
      ) : (
        <span className="manage-env-missing" data-testid={`${testid}-missing`}>{t("manage.env.notFound")}</span>
      )}
    </span>
  );
}

/**
 * One place to answer "what is the plugin actually unhappy about?" (spec 003
 * US4).
 *
 * The rule this panel exists to enforce: a source that was never read is *not*
 * a failure, and a source that recovered must not keep an old error. Both
 * mistakes make this screen cry wolf, and a screen that cries wolf gets ignored
 * — which is how the silent failures got here in the first place.
 *
 * Also home to the pi environment card (version, binary path, agent dir,
 * self-update) — it used to share the manage root's top bar with the trust
 * status, which the narrow tool window squeezed into an unreadable strip.
 * The testids keep their historical names (manage-env, pi-update, …): they
 * anchor the e2e specs and the 011 spec docs.
 */
export default function DiagnosticsPanel({ api, bridge }: { api: ReturnType<typeof manageApi>; bridge: Bridge }) {
  const sources = usePiStore((s) => s.sources);
  const retrySource = usePiStore((s) => s.retrySource);
  const { t } = useT();
  const summary = summarize(sources);
  const overall = summarizeState(sources);

  // The environment is read on entry (not cached in the store): a version seen
  // after an update must be a fresh read, and the card only exists on this tab.
  const [env, setEnv] = useState<EnvironmentResult | null>(null);
  const refreshEnv = useCallback(async () => {
    setEnv(await api.environment().catch(() => null));
  }, [api]);
  useEffect(() => {
    void refreshEnv();
  }, [refreshEnv]);

  // pi self-update (spec 001 US3). There is no check-update subcommand, so the
  // env card only shows the current version plus an on-demand entry; the
  // outcome is whatever `pi update --self` prints (T016 — no "new version
  // available" badge, the plugin must not guess).
  const piStatus = usePiStore((s) => s.piStatus);
  const piRunning = piStatus === "running" || piStatus === "starting";
  const [updating, setUpdating] = useState(false);
  const [updateConfirm, setUpdateConfirm] = useState(false);
  const [updateOutcome, setUpdateOutcome] = useState<EnvUpdateResult | null>(null);

  const runEnvUpdate = useCallback(async () => {
    setUpdateConfirm(false);
    setUpdating(true);
    try {
      const res = await api.envUpdate();
      setUpdateOutcome(res);
      if (res.ok) {
        // The old binary is gone: replace a running process (T018); the status
        // bar version follows the pi-state events. Not running → nothing to
        // replace, the restart call would only fail.
        if (piRunning) {
          await bridge.request("rpc.restart").catch(() => null);
        }
        await refreshEnv();
      }
    } catch (e) {
      setUpdateOutcome({ ok: false, error: (e as Error).message });
    } finally {
      setUpdating(false);
    }
  }, [api, bridge, piRunning, refreshEnv]);

  const requestEnvUpdate = () => {
    setUpdateOutcome(null);
    // An update swaps the binary out from under a live session (FR-010):
    // confirm first, and cancelling must not touch anything.
    if (piRunning) {
      setUpdateConfirm(true);
    } else {
      void runEnvUpdate();
    }
  };

  return (
    <div className="diagnostics" data-testid="diagnostics-panel" data-state={overall}>
      <div className="diagnostics-summary" data-testid="diag-summary" data-state={overall}>
        {overall === "ok" ? (
          <span>All good — every data source loaded.</span>
        ) : overall === "failed" ? (
          <span>
            {summary.failed} source{summary.failed > 1 ? "s" : ""} failing. Retry below, or restart pi from
            the status bar.
          </span>
        ) : overall === "loading" ? (
          <span>Loading…</span>
        ) : (
          // Not a fault: a source nobody has asked for yet simply has no data.
          <span>
            {summary.idle} source{summary.idle > 1 ? "s" : ""} not loaded yet.
          </span>
        )}
      </div>

      <div className="diag-env" data-testid="manage-env">
        {env ? (
          env.found ? (
            <span className="diag-env-version">
              pi <b data-testid="pi-version">{env.version || "?"}</b> · <span className="mono">{env.path}</span>
            </span>
          ) : (
            <span className="manage-env-missing">
              {t("manage.env.missing")}{" "}
              <code>npm install -g @earendil-works/pi-coding-agent</code> {t("manage.env.missingEnd")}
            </span>
          )
        ) : (
          <span>{t("manage.env.detecting")}</span>
        )}
        {env?.agentDir ? <span className="mono diag-env-dir">~/.pi/agent</span> : null}
        {/* 036 US1/US2: the card answers the full "what is on this machine?" question. */}
        {env ? <ToolLine label="node" tool={env.node} homeDir={env.homeDir} testid="env-node" /> : null}
        {env ? <ToolLine label="npm" tool={env.npm} homeDir={env.homeDir} testid="env-npm" /> : null}
        {env ? (
          <span className="diag-env-row" data-testid="env-plugin">
            <span className="diag-env-label">{t("manage.env.plugin")}</span>
            <b data-testid="plugin-version">{env.pluginVersion || t("manage.env.unknown")}</b>
            <span className="diag-env-path" data-testid="plugin-build">
              {t("manage.env.built")} {env.buildTime || t("manage.env.unknown")}
              {" · "}
              {env.commitId || t("manage.env.unknown")}
            </span>
          </span>
        ) : null}
        {env?.found ? (
          <button className="btn diag-env-update" data-testid="pi-update" disabled={updating} onClick={requestEnvUpdate}>
            {updating ? t("manage.env.updating") : t("manage.env.update")}
          </button>
        ) : null}
      </div>

      {updateConfirm ? (
        <div className="trust-confirm" data-testid="env-update-confirm">
          <div className="trust-confirm-title">{t("manage.env.updateConfirm")}</div>
          <div className="trust-confirm-actions">
            <button
              className="btn btn-send"
              data-testid="env-update-confirm-yes"
              onClick={() => void runEnvUpdate()}
              disabled={updating}
            >
              {t("manage.env.updateYes")}
            </button>
            <button className="btn" data-testid="env-update-confirm-no" onClick={() => setUpdateConfirm(false)} disabled={updating}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : null}
      {updateOutcome ? (
        <div
          className={`outcome-banner ${updateOutcome.ok ? "outcome-ok" : "outcome-fail"}`}
          data-testid="env-update-result"
        >
          {updateOutcome.ok ? "✓ " : "✗ "}
          {updateOutcome.output || updateOutcome.error}
        </div>
      ) : null}

      <ul className="diag-list">
        {SOURCE_IDS.map((id: SourceId) => {
          const state = sources[id];
          const detail =
            state.status === "failed"
              ? state.error
              : state.status === "unsupported"
                ? "not implemented by this bridge"
                : "";
          return (
            <li key={id} className="diag-item">
              <div className="panel-row" data-testid={`diag-row-${id}`} data-status={state.status}>
                <span className="panel-row-main">
                  <span className="panel-row-title">{SOURCE_LABELS[id]}</span>
                  <span className="panel-row-sub diag-error" data-testid={`diag-error-${id}`}>
                    {detail}
                  </span>
                </span>
                <span
                  className={`diag-badge diag-badge-${state.status}`}
                  data-testid={`diag-status-${id}`}
                  data-status={state.status}
                >
                  {STATUS_LABEL[state.status]}
                  {state.status === "failed" && state.retries > 1 ? ` ×${state.retries}` : ""}
                </span>
                <span className="panel-row-actions">
                  <button
                    type="button"
                    className="btn"
                    data-testid={`diag-retry-${id}`}
                    disabled={state.inflight || state.status === "unsupported"}
                    title={
                      state.status === "unsupported"
                        ? "This bridge does not implement the call"
                        : `Re-read ${SOURCE_LABELS[id].toLowerCase()}`
                    }
                    onClick={() => void retrySource(id)}
                  >
                    {state.inflight ? "Retrying…" : "Retry"}
                  </button>
                </span>
              </div>
              {/* Truncation belongs in the menu summary, not here (FR-011). */}
              {state.status === "failed" && state.fullError && state.fullError !== state.error ? (
                <details className="diag-details" data-testid={`diag-details-${id}`}>
                  <summary>Full error</summary>
                  <pre className="diag-full mono">{state.fullError}</pre>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
