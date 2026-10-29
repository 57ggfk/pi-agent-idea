import { useEffect, useState } from "react";
import { usePiStore } from "../store/store";
import { getBridge } from "../bridge";
import { manageApi, type EnvironmentResult } from "../manage";
import McpPanel from "./manage/McpPanel";
import PackagesPanel from "./manage/PackagesPanel";
import SkillsPanel from "./manage/SkillsPanel";
import AuthPanel from "./manage/AuthPanel";
import SettingsPanel from "./manage/SettingsPanel";

export type ManageTab = "mcp" | "packages" | "skills" | "auth" | "settings";

const TABS: Array<{ id: ManageTab; label: string }> = [
  { id: "mcp", label: "MCP Servers" },
  { id: "packages", label: "Packages" },
  { id: "skills", label: "Skills" },
  { id: "auth", label: "Auth" },
  { id: "settings", label: "Settings" },
];

export function useManageApi() {
  const [api, setApi] = useState<ReturnType<typeof manageApi> | null>(null);
  const [env, setEnv] = useState<EnvironmentResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bridge = await getBridge();
      const a = manageApi(bridge);
      if (cancelled) return;
      setApi(a);
      setEnv(await a.environment().catch(() => null));
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return { api, env };
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

export default function ManageView() {
  const [tab, setTab] = useState<ManageTab>("mcp");
  const { api, env } = useManageApi();

  return (
    <div className="manage-view-full" data-testid="manage-view">
      <div className="manage-env" data-testid="manage-env">
        {env ? (
          env.found ? (
            <span>
              pi <b>{env.version || "?"}</b> · <span className="mono">{env.path}</span>
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
        {env?.agentDir ? <span className="mono">~/.pi/agent</span> : null}
      </div>

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
          <SkillsPanel api={api} />
        ) : tab === "auth" ? (
          <AuthPanel api={api} />
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
