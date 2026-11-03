import { Fragment, useCallback, useEffect, useState } from "react";
import type { manageApi, AuthOverviewResult, ProviderInfoResult } from "../../manage";

type StatusMap = Record<string, string>;

/**
 * Renders one config value. Sensitive keys arrive as booleans — the raw value
 * never crosses the bridge (spec 001 T019), so a boolean simply means
 * "configured or not" and everything else is shown verbatim. Objects recurse
 * into their own rows (e.g. `headers.Authorization` gets its own flag row).
 */
function ConfigValue({ value }: { value: unknown }) {
  if (typeof value === "boolean") {
    return (
      <span className={`config-flag ${value ? "config-set" : "config-unset"}`} data-configured={value}>
        {value ? "configured" : "not configured"}
      </span>
    );
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return (
      <>
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <span className="provider-config-row" key={k} data-testid={`provider-config-${k}`}>
            <span className="mono">{k}</span>
            <span className="mono">
              <ConfigValue value={v} />
            </span>
          </span>
        ))}
      </>
    );
  }
  return <>{typeof value === "string" ? value : JSON.stringify(value)}</>;
}

export default function AuthPanel({ api }: { api: ReturnType<typeof manageApi> }) {
  const [overview, setOverview] = useState<AuthOverviewResult | null>(null);
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ProviderInfoResult | null>>({});
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [openNote, setOpenNote] = useState<string | null>(null);

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

  const toggleDetail = async (provider: string) => {
    setOpenNote(null);
    if (expanded === provider) {
      setExpanded(null);
      return;
    }
    setExpanded(provider);
    if (details[provider] === undefined) {
      setLoadingDetail(true);
      const res = await api.modelsReadProvider({ name: provider }).catch(
        (e: Error): ProviderInfoResult => ({ ok: false, error: e.message }),
      );
      setDetails((prev) => ({ ...prev, [provider]: res }));
      setLoadingDetail(false);
    }
  };

  const openInEditor = async (provider: string) => {
    setOpenNote(null);
    try {
      const res = await api.modelsOpenFile({ provider });
      setOpenNote(`${res.created ? "Created and opened" : "Opened"} ${res.path}`);
    } catch (e) {
      setOpenNote(`could not open models.json: ${(e as Error).message}`);
    }
  };

  const providers = overview?.providers ?? [];
  const withCreds = new Set(overview?.withCredentials ?? []);

  return (
    <div data-testid="auth-panel">
      {/* models.json problems are announced once, up front (FR-013): a missing
          file is "nothing configured yet", a corrupt one shows the parse error
          with its position. The panel never goes silently blank. */}
      {overview && overview.modelsState !== "ok" ? (
        <div className="panel-note" data-testid="models-state" data-state={overview.modelsState}>
          {overview.modelsState === "corrupt"
            ? overview.modelsError
            : `models.json not found at ${overview.modelsPath} — no custom providers configured yet.`}
        </div>
      ) : null}
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
      {openNote ? (
        <div className="panel-note" data-testid="models-open-note">
          {openNote}
        </div>
      ) : null}
      {providers.map((p) => {
        const detail = details[p];
        return (
          <Fragment key={p}>
            <div className="panel-row" data-testid="auth-provider-row">
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
                  data-testid={`provider-toggle-${p}`}
                  aria-expanded={expanded === p}
                  title="Show configuration from models.json"
                  onClick={() => void toggleDetail(p)}
                >
                  {expanded === p ? "▾" : "▸"}
                </button>
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
            {expanded === p ? (
              <div className="provider-detail" data-testid={`provider-detail-${p}`}>
                {loadingDetail ? <div className="panel-note">Loading…</div> : null}
                {detail && !detail.ok ? (
                  <div className="panel-note" data-testid={`provider-detail-error-${p}`}>
                    {detail.error}
                  </div>
                ) : null}
                {detail?.ok ? (
                  <>
                    <div className="panel-row-actions provider-detail-actions">
                      <button
                        className="btn"
                        data-testid={`provider-open-file-${p}`}
                        onClick={() => void openInEditor(p)}
                      >
                        Open models.json in editor
                      </button>
                    </div>
                    {Object.entries(detail.config ?? {}).map(([k, v]) => (
                      <div className="provider-config-row" key={k} data-testid={`provider-config-${k}`}>
                        <span className="mono">{k}</span>
                        <span className="mono">
                          <ConfigValue value={v} />
                        </span>
                      </div>
                    ))}
                  </>
                ) : null}
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
