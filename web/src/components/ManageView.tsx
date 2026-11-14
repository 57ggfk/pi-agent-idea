import { useCallback, useEffect, useState } from "react";
import { usePiStore } from "../store/store";
import { getBridge } from "../bridge";
import { requestRepaint } from "../lib/repaint";
import type { Bridge } from "../bridge/types";
import { manageApi, type TrustState, type TrustWriteResult } from "../manage";
import { useT } from "../i18n/useT";
import McpPanel from "./manage/McpPanel";
import PackagesPanel from "./manage/PackagesPanel";
import SkillsPanel from "./manage/SkillsPanel";
import AuthPanel from "./manage/AuthPanel";
import AgentsPanel from "./manage/AgentsPanel";
import SettingsPanel from "./manage/SettingsPanel";
import DiagnosticsPanel from "./manage/DiagnosticsPanel";

export type ManageTab = "mcp" | "packages" | "skills" | "agents" | "auth" | "settings" | "diagnostics";

const TABS: Array<{ id: ManageTab; labelKey: "manage.tab.mcp" | "manage.tab.packages" | "manage.tab.skills" | "manage.tab.agents" | "manage.tab.auth" | "manage.tab.settings" | "manage.tab.diagnostics" }> = [
  { id: "mcp", labelKey: "manage.tab.mcp" },
  { id: "packages", labelKey: "manage.tab.packages" },
  { id: "skills", labelKey: "manage.tab.skills" },
  { id: "agents", labelKey: "manage.tab.agents" },
  { id: "auth", labelKey: "manage.tab.auth" },
  { id: "settings", labelKey: "manage.tab.settings" },
  { id: "diagnostics", labelKey: "manage.tab.diagnostics" },
];

/** Resource categories shown in the trust confirmation, even before they exist. */
const TRUST_CATEGORIES: Array<{ type: string; labelKey: "manage.trust.category.skills" | "manage.trust.category.mcp" | "manage.trust.category.settings" | "manage.trust.category.extensions" }> = [
  { type: "skills", labelKey: "manage.trust.category.skills" },
  { type: "mcp", labelKey: "manage.trust.category.mcp" },
  { type: "settings", labelKey: "manage.trust.category.settings" },
  { type: "extensions", labelKey: "manage.trust.category.extensions" },
];

export function useManageApi() {
  const [api, setApi] = useState<ReturnType<typeof manageApi> | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  // Entering Manage swaps a full panel under the tabs — force the JCEF frame
  // so the screen never keeps the previous tab's paint (OSR frame lag).
  // 021 T301: goes through the debounced entry point.
  useEffect(() => {
    if (api) requestRepaint();
  }, [api]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const b = await getBridge();
      const a = manageApi(b);
      if (cancelled) return;
      setApi(a);
      setBridge(b);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return { api, bridge };
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
  // The sub-tab lives in the store: re-entering Manage must not reset it,
  // and remount churn is part of why sub-tab switches felt non-smooth.
  const tab = usePiStore((s) => s.manageTab);
  const setTab = usePiStore((s) => s.setManageTab);
  const { t } = useT();
  const { api, bridge } = useManageApi();
  const trust = useTrust(api);
  const trusted = trust.state?.trusted === true;
  const unreadable = !trusted && trust.error != null;

  // The pi environment (version, binary path, agent dir, self-update) moved to
  // the diagnostics tab: four items on one bar squeezed the trust status into
  // vertical character wrap at tool-window width.

  return (
    <div className="manage-view-full" data-testid="manage-view">
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
            <b>{unreadable ? t("manage.trust.unreadable") : t("manage.trust.untrusted")}</b>
            {unreadable ? (
              <span className="trust-banner-detail mono">{trust.error}</span>
            ) : (
              <span className="trust-banner-detail">{t("manage.trust.untrustedDetail")}</span>
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
                {t("manage.trust.retry")}
              </button>
            ) : (
              <button className="btn btn-send" data-testid="trust-grant" onClick={() => trust.openPrompt("grant")}>
                {t("manage.trust.grant")}
              </button>
            )}
          </div>
        </div>
      ) : trusted ? (
        <div className="manage-env">
          <span className="trust-status" data-testid="trust-status" data-state="trusted">
            {t("manage.env.trusted")}
            <button className="link-btn" data-testid="trust-revoke" onClick={() => trust.openPrompt("revoke")}>
              {t("manage.env.revoke")}
            </button>
          </span>
        </div>
      ) : null}

      {trust.prompt ? (
        <div className="trust-confirm" data-testid="trust-confirm" data-action={trust.prompt}>
          <div className="trust-confirm-title">
            {trust.prompt === "grant" ? t("manage.trust.grantPrompt") : t("manage.trust.revokePrompt")}
          </div>
          <ul className="trust-resources" data-testid="trust-confirm-list">
            {(trust.state?.resources?.length
              ? trust.state.resources.map((r) => ({ type: r.type, label: r.label ?? r.type }))
              : TRUST_CATEGORIES.map((c) => ({ type: c.type, label: t(c.labelKey) }))
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
              {trust.prompt === "grant" ? t("manage.trust.confirmGrant") : t("manage.trust.confirmRevoke")}
            </button>
            <button className="btn" data-testid="trust-confirm-no" onClick={trust.cancel} disabled={trust.busy}>
              {t("common.cancel")}
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
            ? t("manage.trust.granted")
            : t("manage.trust.revoked")}
        </div>
      ) : null}

      <div className="manage-tabs">
        {TABS.map((tabItem) => (
          <button
            key={tabItem.id}
            className={`tab ${tab === tabItem.id ? "tab-active" : ""}`}
            data-testid={`manage-tab-${tabItem.id}`}
            onClick={() => {
              setTab(tabItem.id);
              // OSR frame-lag workaround: force a full JCEF frame after the
              // panel swap, or the screen keeps the previous sub-tab's paint.
              requestRepaint();
            }}
          >
            {t(tabItem.labelKey)}
          </button>
        ))}
      </div>

      <div className="manage-content">
        {!api || !bridge ? (
          <div className="loading">Loading…</div>
        ) : tab === "mcp" ? (
          <McpPanel api={api} />
        ) : tab === "packages" ? (
          <PackagesPanel api={api} />
        ) : tab === "skills" ? (
          <SkillsPanel api={api} bridge={bridge} trusted={trusted} />
        ) : tab === "agents" ? (
          <AgentsPanel api={api} trusted={trusted} />
        ) : tab === "auth" ? (
          <AuthPanel api={api} />
        ) : tab === "diagnostics" ? (
          <DiagnosticsPanel api={api} bridge={bridge} />
        ) : (
          <SettingsPanel api={api} />
        )}
      </div>
    </div>
  );
}
