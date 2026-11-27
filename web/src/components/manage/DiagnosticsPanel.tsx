import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePiStore } from "../../store/store";
import type { Bridge } from "../../bridge/types";
import { manageApi, type EnvUpdateResult, type EnvironmentResult, type ToolStatus } from "../../manage";
import { useT } from "../../i18n/useT";
import { shortPath } from "../../lib/shortPath";
import { piVersionDisplay } from "../../lib/piVersion";
import {
  SOURCE_IDS,
  SOURCE_LABEL_KEYS,
  summarize,
  summarizeState,
  type SourceId,
  type SourceStatus,
} from "../../store/sources";

/** i18n keys per status — the panel's labels follow the UI language (008/036). */
const STATUS_LABEL_KEY = {
  ready: "manage.diag.status.ready",
  loading: "manage.diag.status.loading",
  failed: "manage.diag.status.failed",
  unsupported: "manage.diag.status.unsupported",
  idle: "manage.diag.status.idle",
} as const satisfies Record<SourceStatus, string>;

/**
 * One row of the environment card (issue #14 FR-001): a label on the left,
 * the value on the right, one item per line.
 *
 * The value has three states, and each row carries its own: the value is
 * known, it is still being read (the bridge read is per row, not per card),
 * or the probe failed ("not found" / "unknown") — never a blank.
 */
function EnvRow({
  label,
  testid,
  children,
}: {
  label: string;
  testid: string;
  children: ReactNode;
}) {
  return (
    <div className="diag-env-row" data-testid={testid}>
      <span className="diag-env-label">{label}</span>
      <span className="diag-env-value">{children}</span>
    </div>
  );
}

/**
 * A path in the environment card (issue #14 FR-002): it never breaks in the
 * middle — the full path stays in the tooltip and the visible text is
 * ellipsized. On narrow panels the `~/`-shortened form takes over (the
 * shared .skill-path-* CSS switch the skills rows already use).
 */
function EnvPath({
  path,
  homeDir,
  testid,
}: {
  path: string;
  homeDir?: string;
  testid: string;
}) {
  return (
    <span className="diag-env-path mono" title={path} data-testid={testid}>
      <span className="skill-path-full" data-testid={`${testid}-full`}>{path}</span>
      <span className="skill-path-short" data-testid={`${testid}-short`}>{shortPath(path, homeDir)}</span>
    </span>
  );
}

/**
 * One tool line in the environment card (036 FR-001/FR-002): `node vX.Y.Z`
 * plus its path — full path on wide panels, `~/`-shortened on narrow ones
 * (the shared .skill-path-* CSS switch). A missing tool is an explicit
 * "not found", never a blank.
 */
function ToolLine({ label, tool, homeDir, testid }: { label: string; tool?: ToolStatus; homeDir?: string; testid: string }) {
  const { t } = useT();
  return (
    <EnvRow label={label} testid={testid}>
      {tool === undefined ? (
        <span data-testid={`${testid}-detecting`}>{t("manage.env.detecting")}</span>
      ) : tool.found ? (
        <>
          <b data-testid={`${testid}-version`}>{tool.version || t("manage.env.unknown")}</b>
          <EnvPath path={tool.path} homeDir={homeDir} testid={`${testid}-path`} />
        </>
      ) : (
        <span className="manage-env-missing" data-testid={`${testid}-missing`}>{t("manage.env.notFound")}</span>
      )}
    </EnvRow>
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
  // Issue #14 FR-003/FR-005: the versions come from the store — the same
  // facts the status bar shows, read by the same helper, so the two places
  // cannot tell different stories. They arrive asynchronously and never
  // block the first paint.
  const piVersion = usePiStore((s) => s.piVersion);
  const piDiskVersion = usePiStore((s) => s.piDiskVersion);
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

  /**
   * The version on disk.
   *
   * The watcher's fact (pi-disk-version) is the source; the environment read
   * carries the same number as a fallback for the moment before the watcher
   * has reported (the Kotlin side reads it from disk, without a
   * subprocess). It is the SAME fact, not a second probe.
   */
  const diskVersion = piDiskVersion || env?.version || "";
  // The same helper the status bar uses, so the two cannot disagree about
  // what "the disk moved on" means (FR-005).
  const version = piVersionDisplay(piVersion, diskVersion);

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
          <span>{t("manage.diag.summary.ok")}</span>
        ) : overall === "failed" ? (
          <span>{t("manage.diag.summary.failed", { count: summary.failed })}</span>
        ) : overall === "loading" ? (
          <span>{t("manage.diag.summary.loading")}</span>
        ) : (
          // Not a fault: a source nobody has asked for yet simply has no data.
          <span>{t("manage.diag.summary.idle", { count: summary.idle })}</span>
        )}
      </div>

      {/*
        Issue #14 — the environment card is a vertical list, one item per row,
        with the label column aligned. Every row carries its own unknown
        state: the bridge read must not hold the whole card back (FR-003).
      */}
      <div className="diag-env" data-testid="manage-env">
        <div className="diag-env-list">
          {/* The two versions are the store's facts — the same ones the
              status bar shows (FR-005), so the two places cannot disagree. */}
          <EnvRow label={t("manage.env.runningVersion")} testid="env-running-version">
            {piVersion ? (
              <b data-testid="pi-running-version">{piVersion}</b>
            ) : (
              <span data-testid="pi-running-version-unknown">{t("manage.env.unknown")}</span>
            )}
          </EnvRow>
          {/* The historical "pi-version" testid stays on the version the
              card shows as "installed" — the specs anchor on it. */}
          <EnvRow label={t("manage.env.diskVersion")} testid="env-disk-version">
            {diskVersion ? (
              <b data-testid="pi-version">{diskVersion}</b>
            ) : (
              <span data-testid="pi-version-unknown">{t("manage.env.unknown")}</span>
            )}
          </EnvRow>
          {/* US3: the disk moved on — say it in the same words the status
              bar uses, so the two places read the same. */}
          {version.differs ? (
            <div className="diag-env-note" data-testid="env-disk-note">
              {t("status.diskVersionTitle", { version: diskVersion })}
            </div>
          ) : null}

          <EnvRow label={t("manage.env.piPath")} testid="env-pi-path">
            {env === null ? (
              <span data-testid="env-pi-path-detecting">{t("manage.env.detecting")}</span>
            ) : env.found && env.path ? (
              <EnvPath path={env.path} homeDir={env.homeDir} testid="env-pi-path-value" />
            ) : (
              <span className="manage-env-missing" data-testid="env-pi-missing">
                {t("manage.env.missing")}{" "}
                <code>npm install -g @earendil-works/pi-coding-agent</code> {t("manage.env.missingEnd")}
              </span>
            )}
          </EnvRow>

          <EnvRow label={t("manage.env.agentDir")} testid="env-agent-dir">
            {env === null ? (
              <span data-testid="env-agent-dir-detecting">{t("manage.env.detecting")}</span>
            ) : env.agentDir ? (
              <EnvPath path={env.agentDir} homeDir={env.homeDir} testid="env-agent-dir-value" />
            ) : (
              <span data-testid="env-agent-dir-unknown">{t("manage.env.unknown")}</span>
            )}
          </EnvRow>

          {/* 036 US1/US2: the card answers the full "what is on this machine?" question. */}
          <ToolLine label="node" tool={env?.node} homeDir={env?.homeDir} testid="env-node" />
          <ToolLine label="npm" tool={env?.npm} homeDir={env?.homeDir} testid="env-npm" />

          <EnvRow label={t("manage.env.plugin")} testid="env-plugin">
            {env === null ? (
              <span data-testid="env-plugin-detecting">{t("manage.env.detecting")}</span>
            ) : (
              <>
                <b data-testid="plugin-version">{env.pluginVersion || t("manage.env.unknown")}</b>
                <span className="diag-env-path" data-testid="plugin-build">
                  {t("manage.env.built")} {env.buildTime || t("manage.env.unknown")}
                  {" · "}
                  {env.commitId || t("manage.env.unknown")}
                </span>
              </>
            )}
          </EnvRow>
        </div>
        {/* The action is a row of its own, and it never waits for a version
            (FR-003): the button is about the installation, not about a
            number. */}
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
          const label = t(SOURCE_LABEL_KEYS[id]);
          const detail =
            state.status === "failed"
              ? state.error
              : state.status === "unsupported"
                ? t("manage.diag.detail.unsupported")
                : "";
          return (
            <li key={id} className="diag-item">
              <div className="panel-row" data-testid={`diag-row-${id}`} data-status={state.status}>
                <span className="panel-row-main">
                  <span className="panel-row-title">{label}</span>
                  <span className="panel-row-sub diag-error" data-testid={`diag-error-${id}`}>
                    {detail}
                  </span>
                </span>
                <span
                  className={`diag-badge diag-badge-${state.status}`}
                  data-testid={`diag-status-${id}`}
                  data-status={state.status}
                >
                  {t(STATUS_LABEL_KEY[state.status])}
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
                        ? t("manage.diag.retryUnsupportedTitle")
                        : t("manage.diag.retryTitle", { name: label })
                    }
                    onClick={() => void retrySource(id)}
                  >
                    {state.inflight ? t("manage.diag.retrying") : t("manage.diag.retry")}
                  </button>
                </span>
              </div>
              {/* Truncation belongs in the menu summary, not here (FR-011). */}
              {state.status === "failed" && state.fullError && state.fullError !== state.error ? (
                <details className="diag-details" data-testid={`diag-details-${id}`}>
                  <summary>{t("manage.diag.fullError")}</summary>
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
