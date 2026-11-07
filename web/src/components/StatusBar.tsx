import { usePiStore } from "../store/store";
import { useT } from "../i18n/useT";
import SessionTitleInput from "./SessionTitleInput";
import Icon from "./Icon";

export default function StatusBar() {
  const { t } = useT();
  const stats = usePiStore((s) => s.stats);
  const piStatus = usePiStore((s) => s.piStatus);
  const piVersion = usePiStore((s) => s.piVersion);
  const exitMessage = usePiStore((s) => s.exitMessage);
  const exitStderr = usePiStore((s) => s.exitStderr);
  const sessionName = usePiStore((s) => s.sessionName);
  const bridgeKind = usePiStore((s) => s.bridgeKind);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const restartPi = usePiStore((s) => s.restartPi);
  const tab = usePiStore((s) => s.tab);
  const editingSessionTitle = usePiStore((s) => s.editingSessionTitle);
  const beginEditSessionTitle = usePiStore((s) => s.beginEditSessionTitle);
  const sessions = usePiStore((s) => s.sessions);
  const sessionId = usePiStore((s) => s.sessionId);
  // The bar editor is for the live session only; a row editor on the
  // sessions tab targets another session's file and must not land here.
  const editingCurrent =
    editingSessionTitle === "current" ||
    (editingSessionTitle != null &&
      editingSessionTitle === sessions.find((s) => s.id === sessionId)?.file);

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
            <Icon name="refresh" className="ic-sm" />
            Restart
          </button>
        </div>
      ) : null}
      <div className="statusbar-row">
        <span className={`status-dot ${piStatus} ${isStreaming ? "busy" : ""}`} data-testid="status-dot" />
        <span data-testid="status-version">pi {piVersion || "—"}</span>
        {editingCurrent && tab !== "sessions" ? (
          // The one inline editor on chat/manage tabs (T108); the session
          // list hosts it on the sessions tab — never both at once.
          <SessionTitleInput testId="status-session-edit" variant="bar" />
        ) : sessionName ? (
          // Chip, not bare text: a bare auto-derived title reads like a stray
          // message in the bar; icon + border make it a clickable name.
          <button
            type="button"
            className="status-session status-session-btn"
            data-testid="status-session"
            title={`${sessionName} — ${t("sessions.renameTitle")}`}
            aria-label={t("sessions.renameTitle")}
            onClick={() => beginEditSessionTitle()}
          >
            <Icon name="tag" className="ic-sm" />
            <span className="status-session-name">{sessionName}</span>
          </button>
        ) : null}
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
