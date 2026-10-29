import { useCallback, useEffect, useState } from "react";
import type { manageApi, AuthOverviewResult } from "../../manage";

type StatusMap = Record<string, string>;

export default function AuthPanel({ api }: { api: ReturnType<typeof manageApi> }) {
  const [overview, setOverview] = useState<AuthOverviewResult | null>(null);
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [checking, setChecking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setOverview(await api.authOverview().catch(() => null));
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const check = async (provider: string) => {
    setChecking(provider);
    try {
      const res = await api.authCheck({ provider });
      setStatuses((prev) => ({ ...prev, [provider]: res.status }));
    } catch (e) {
      setStatuses((prev) => ({ ...prev, [provider]: `error: ${(e as Error).message}` }));
    } finally {
      setChecking(null);
    }
  };

  const providers = overview?.providers ?? [];
  const withCreds = new Set(overview?.withCredentials ?? []);

  return (
    <div data-testid="auth-panel">
      <div className="panel-toolbar">
        <button className="btn" data-testid="auth-refresh" onClick={() => void refresh()}>
          Refresh
        </button>
        <span className="panel-row-sub">Checks run `pi auth check --no-refresh` per provider.</span>
      </div>
      {providers.length === 0 ? (
        <div className="panel-empty" data-testid="auth-empty">
          No providers with stored credentials or custom models yet.
        </div>
      ) : null}
      {providers.map((p) => (
        <div className="panel-row" key={p} data-testid="auth-provider-row">
          <div className="panel-row-main">
            <span className="panel-row-title">{p}</span>
            <span className="panel-row-sub">
              {withCreds.has(p) ? "credentials stored" : "custom provider (models.json)"}
              {statuses[p] ? ` · ${statuses[p]}` : ""}
            </span>
          </div>
          <div className="panel-row-actions">
            <button
              className="btn"
              data-testid={`auth-check-${p}`}
              onClick={() => void check(p)}
              disabled={checking === p}
            >
              {checking === p ? "…" : "Check"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
