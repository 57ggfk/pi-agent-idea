import { useCallback, useEffect, useState } from "react";
import { usePiStore } from "../store/store";
import { getBridge } from "../bridge";
import type { Bridge } from "../bridge/types";
import { manageApi, type EnvironmentResult, type EnvUpdateResult, type TrustState, type TrustWriteResult } from "../manage";
import McpPanel from "./manage/McpPanel";
import PackagesPanel from "./manage/PackagesPanel";
import SkillsPanel from "./manage/SkillsPanel";
import AuthPanel from "./manage/AuthPanel";
import SettingsPanel from "./manage/SettingsPanel";
import DiagnosticsPanel from "./manage/DiagnosticsPanel";

export type ManageTab = "mcp" | "packages" | "skills" | "auth" | "settings" | "diagnostics";

const TABS: Array<{ id: ManageTab; label: string }> = [
  { id: "mcp", label: "MCP Servers" },
  { id: "packages", label: "Packages" },
  { id: "skills", label: "Skills" },
  { id: "auth", label: "Auth" },
  { id: "settings", label: "Settings" },
  { id: "diagnostics", label: "Diagnostics" },
];

/** Resource categories shown in the trust confirmation, even before they exist. */
const TRUST_CATEGORIES: Array<{ type: string; label: string }> = [
  { type: "skills", label: "Project skills" },
  { type: "mcp", label: "MCP servers" },
  { type: "settings", label: "Project settings" },
  { type: "extensions", label: "Extensions" },
];

export function useManageApi() {
  const [api, setApi] = useState<ReturnType<typeof manageApi> | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [env, setEnv] = useState<EnvironmentResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const b = await getBridge();
      const a = manageApi(b);
      if (cancelled) return;
      setApi(a);
      setBridge(b);
      setEnv(await a.environment().catch(() => null));
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const refreshEnv = useCallback(async () => {
    if (!api) return;
    setEnv(await api.environment().catch(() => null));
  }, [api]);
  return { api, bridge, env, refreshEnv };
}

export function OutcomeBanner({ outcome }: { outcome: { ok: boolean; error?: string; output?: string } | null }) {
  if (!outcome) return null;
  return (
    <div className={`outcome-banner ${outcome.ok ? "outcome-ok" : "outcome-fail"}`} data-testid="outcome-banner">
      {outcome.ok ? "✓ " : "✗ "}
      {outcome.error || outcome.output}
    </div>
  );
}

type TrustPrompt = "grant" | "revoke";

/**
 * Reads the project trust state and exposes the grant/revoke flow.
 *
 * Trust is never inferred in the UI: `trust.json` is the single source, and an
 * unreadable store is surfaced instead of being silently treated as trusted.
 */
function useTrust(api: ReturnType<typeof manageApi> | null) {
  const [state, setState] = useState<TrustState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<TrustPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TrustWriteResult | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.trustGet();
      setState(next);
      setError(next.ok === false ? next.error ?? "trust.json could not be read" : null);
    } catch (e) {
      // A bridge failure is not "trusted": show it and stay on the safe side.
      setError((e as Error).message);
      setState({ ok: false, trusted: false, path: "", resources: [] });
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const confirm = useCallback(async () => {
    if (!api || !prompt) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = prompt === "grant" ? await api.trustGrant() : await api.trustRevoke();
      setOutcome(result);
      if (result.ok) {
        setPrompt(null);
        await refresh();
      }
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [api, prompt, refresh]);

  return {
    state,
    error,
    prompt,
    busy,
    outcome,
    refresh,
    openPrompt: (p: TrustPrompt) => {
      setOutcome(null);
      setPrompt(p);
    },
    cancel: () => setPrompt(null),
    confirm,
  };
}

export default function ManageView() {
  const [tab, setTab] = useState<ManageTab>("mcp");
  const { api, bridge, env, refreshEnv } = useManageApi();
  const trust = useTrust(api);
  const trusted = trust.state?.trusted === true;
  const unreadable = !trusted && trust.error != null;

  // pi self-update (spec 001 US3). There is no check-update subcommand, so the
  // env area only shows the current version plus an on-demand entry; the
  // outcome is whatever `pi update --self` prints (T016 — no "new version
  // available" badge, the plugin must not guess).
  const piStatus = usePiStatus();
  const piRunning = piStatus === "running" || piStatus === "starting";
  const [updating, setUpdating] = useState(false);
  const [updateConfirm, setUpdateConfirm] = useState(false);
  const [updateOutcome, setUpdateOutcome] = useState<EnvUpdateResult | null>(null);

  const runEnvUpdate = useCallback(async () => {
    if (!api) return;
    setUpdateConfirm(false);
    setUpdating(true);
    try {
      const res = await api.envUpdate();
      setUpdateOutcome(res);
      if (res.ok) {
        // The old binary is gone: replace a running process (T018); the status
        // bar version follows the pi-state events. Not running → nothing to
        // replace, the restart call would only fail.
        if (piRunning && bridge) {
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
    <div className="manage-view-full" data-testid="manage-view">
      <div className="manage-env" data-testid="manage-env">
        {env ? (
          env.found ? (
            <span>
              pi <b data-testid="pi-version">{env.version || "?"}</b> · <span className="mono">{env.path}</span>
            </span>
          ) : (
            <span className="manage-env-missing">
              pi not found — install with{" "}
              <code>npm install -g @earendil-works/pi-coding-agent</code> then reopen this panel
            </span>
          )
        ) : (
          <span>detecting pi…</span>
        )}
        <span className="spacer" />
        {trusted ? (
          <span className="trust-status" data-testid="trust-status" data-state="trusted">
            项目已信任
            <button className="link-btn" data-testid="trust-revoke" onClick={() => trust.openPrompt("revoke")}>
              撤销信任
            </button>
          </span>
        ) : null}
        {env?.agentDir ? <span className="mono">~/.pi/agent</span> : null}
        {env?.found ? (
          <button className="btn" data-testid="pi-update" disabled={updating} onClick={requestEnvUpdate}>
            {updating ? "Updating…" : "Update pi"}
          </button>
        ) : null}
      </div>

      {updateConfirm ? (
        <div className="trust-confirm" data-testid="env-update-confirm">
          <div className="trust-confirm-title">pi 正在运行。更新会重启 pi 进程，进行中的会话将中断。</div>
          <div className="trust-confirm-actions">
            <button
              className="btn btn-send"
              data-testid="env-update-confirm-yes"
              onClick={() => void runEnvUpdate()}
              disabled={updating}
            >
              继续更新
            </button>
            <button className="btn" data-testid="env-update-confirm-no" onClick={() => setUpdateConfirm(false)} disabled={updating}>
              取消
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

      {/* Only the *problem* states get a banner; a trusted project stays quiet.
          Nothing renders until the state has been read: a warning that flashes
          for a fraction of a second reads as a bug, not as a status. */}
      {trust.state && !trusted ? (
        <div
          className={`trust-banner ${unreadable ? "trust-banner-error" : "trust-banner-warn"}`}
          data-testid="trust-banner"
          data-state={unreadable ? "error" : "untrusted"}
        >
          <div className="trust-banner-text">
            <b>{unreadable ? "无法读取信任配置" : "本项目尚未被 pi 信任，项目级配置不会生效"}</b>
            {unreadable ? (
              <span className="trust-banner-detail mono">{trust.error}</span>
            ) : (
              <span className="trust-banner-detail">
                下面这些项目级内容存在于仓库中，但 pi 启动时会忽略它们。
              </span>
            )}
            {!unreadable && (trust.state?.resources?.length ?? 0) > 0 ? (
              <ul className="trust-resources" data-testid="trust-resources">
                {trust.state!.resources!.map((r) => (
                  <li key={r.type} data-resource={r.type}>
                    {r.label ?? r.type}
                    <span className="mono trust-resource-path">{r.path}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="trust-banner-actions">
            {unreadable ? (
              <button className="btn" data-testid="trust-retry" onClick={() => void trust.refresh()}>
                重试读取
              </button>
            ) : (
              <button className="btn btn-send" data-testid="trust-grant" onClick={() => trust.openPrompt("grant")}>
                信任本项目
              </button>
            )}
          </div>
        </div>
      ) : null}

      {trust.prompt ? (
        <div className="trust-confirm" data-testid="trust-confirm" data-action={trust.prompt}>
          <div className="trust-confirm-title">
            {trust.prompt === "grant"
              ? "信任本项目后，以下项目级配置将对 pi 生效："
              : "撤销信任后，以下项目级配置将不再生效："}
          </div>
          <ul className="trust-resources" data-testid="trust-confirm-list">
            {(trust.state?.resources?.length
              ? trust.state.resources.map((r) => ({ type: r.type, label: r.label ?? r.type }))
              : TRUST_CATEGORIES
            ).map((r) => (
              <li key={r.type} data-resource={r.type}>
                {r.label}
              </li>
            ))}
          </ul>
          <div className="trust-confirm-actions">
            <button
              className={`btn ${trust.prompt === "revoke" ? "btn-abort" : "btn-send"}`}
              data-testid="trust-confirm-yes"
              onClick={() => void trust.confirm()}
              disabled={trust.busy}
            >
              {trust.prompt === "grant" ? "确认信任" : "确认撤销"}
            </button>
            <button className="btn" data-testid="trust-confirm-no" onClick={trust.cancel} disabled={trust.busy}>
              取消
            </button>
          </div>
          {trust.outcome && !trust.outcome.ok ? (
            <div className="outcome-banner outcome-fail" data-testid="trust-error">
              ✗ {trust.outcome.error}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* A grant cannot reach a process that is already running. */}
      {trust.outcome?.ok && trust.outcome.restartRequired ? (
        <div className="trust-notice" data-testid="trust-restart-notice">
          {trust.outcome.trusted
            ? "已信任。当前会话的 pi 进程仍按旧状态运行，新会话生效。"
            : "已撤销。当前会话的 pi 进程仍按已信任状态运行，新会话/重启后才彻底失效。"}
        </div>
      ) : null}

      <div className="manage-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "tab-active" : ""}`}
            data-testid={`manage-tab-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="manage-content">
        {!api ? (
          <div className="loading">Loading…</div>
        ) : tab === "mcp" ? (
          <McpPanel api={api} />
        ) : tab === "packages" ? (
          <PackagesPanel api={api} />
        ) : tab === "skills" ? (
          <SkillsPanel api={api} trusted={trusted} />
        ) : tab === "auth" ? (
          <AuthPanel api={api} />
        ) : tab === "diagnostics" ? (
          <DiagnosticsPanel />
        ) : (
          <SettingsPanel api={api} />
        )}
      </div>
    </div>
  );
}

export function usePiStatus() {
  return usePiStore((s) => s.piStatus);
}
