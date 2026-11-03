import { usePiStore } from "../../store/store";
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
 * One place to answer "what is the plugin actually unhappy about?" (spec 003
 * US4).
 *
 * The rule this panel exists to enforce: a source that was never read is *not*
 * a failure, and a source that recovered must not keep an old error. Both
 * mistakes make this screen cry wolf, and a screen that cries wolf gets ignored
 * — which is how the silent failures got here in the first place.
 */
export default function DiagnosticsPanel() {
  const sources = usePiStore((s) => s.sources);
  const retrySource = usePiStore((s) => s.retrySource);
  const summary = summarize(sources);
  const overall = summarizeState(sources);

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
