import { usePiStore } from "../store/store";

export default function StatusBar() {
  const stats = usePiStore((s) => s.stats);
  const piStatus = usePiStore((s) => s.piStatus);
  const piVersion = usePiStore((s) => s.piVersion);
  const exitMessage = usePiStore((s) => s.exitMessage);
  const exitStderr = usePiStore((s) => s.exitStderr);
  const sessionName = usePiStore((s) => s.sessionName);
  const bridgeKind = usePiStore((s) => s.bridgeKind);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const restartPi = usePiStore((s) => s.restartPi);

  const percent = stats?.contextUsage?.percent;
  const cost = stats?.cost;
  const totalMessages = stats?.totalMessages;

  // Context fill level drives the bar color (green → amber → red).
  const ctxLevel = percent == null ? "ok" : percent >= 90 ? "critical" : percent >= 70 ? "warn" : "ok";

  return (
    <div className="statusbar" data-testid="statusbar">
      {piStatus === "exited" ? (
        <div className="exit-banner" data-testid="exit-banner">
          <span>
            pi exited: {exitMessage}
            {exitStderr ? ` — ${exitStderr.split("\n").slice(-3).join(" | ").slice(0, 300)}` : ""}
          </span>
          <button className="btn btn-restart" data-testid="restart-btn" onClick={() => void restartPi()}>
            ↻ Restart
          </button>
        </div>
      ) : null}
      <div className="statusbar-row">
        <span className={`status-dot ${piStatus} ${isStreaming ? "busy" : ""}`} data-testid="status-dot" />
        <span data-testid="status-version">pi {piVersion || "—"}</span>
        {sessionName ? <span className="status-session">{sessionName}</span> : null}
        <span className="spacer" />
        {percent != null ? (
          <span className="status-ctx" data-testid="status-context" title="Context window usage">
            <span className={`ctx-bar ctx-${ctxLevel}`} data-testid="status-context-bar">
              <span
                className="ctx-bar-fill"
                style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
              />
            </span>
            ctx {Math.round(percent)}%
          </span>
        ) : null}
        {cost != null ? (
          <span className="status-opt" data-testid="status-cost" title="Session cost">
            ${cost.toFixed(4)}
          </span>
        ) : null}
        {totalMessages != null ? (
          <span className="status-opt" data-testid="status-messages">
            {totalMessages} msgs
          </span>
        ) : null}
        {bridgeKind === "mock" ? (
          <span className="status-opt status-mock">MOCK</span>
        ) : null}
      </div>
    </div>
  );
}
