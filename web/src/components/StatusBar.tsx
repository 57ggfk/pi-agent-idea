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
  const piNotice = usePiStore((s) => s.piNotice);
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

  // stderr is diagnostic noise, not the headline. Keep the tail of it for a
  // collapsed details pane instead of dumping it into the banner line.
  const stderrTail = exitStderr.trim()
    ? exitStderr
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(-20)
        .join("\n")
    : "";

  // Context fill level drives the bar color (green → amber → red).
  const ctxLevel = percent == null ? "ok" : percent >= 90 ? "critical" : percent >= 70 ? "warn" : "ok";

  return (
    // The exit banner is a sibling of the status bar, not a child: the status
    // bar is a fixed 28px row, so an error notice inside it was clipped — and
    // the composer painted over the part that stuck out (real machine).
    <div className="statusbar-wrap">
      {piNotice ? (
        // 051: 插件替用户改了启动参数（provider 没了 → 改用默认模型）时，
        // 当面说出来。不是错误：pi 正常跑着，只是没用上次那个模型。
        <div className="notice-banner" data-testid="notice-banner">
          <Icon name="info" className="ic-sm" />
          <span className="notice-banner-msg" data-testid="notice-banner-msg">
            {t("status.staleModel", { provider: piNotice.provider, model: piNotice.model })}
          </span>
        </div>
      ) : null}
      {piStatus === "exited" ? (
        <div className="exit-banner" data-testid="exit-banner">
          <span className="exit-banner-msg" data-testid="exit-banner-msg">
            {t("status.piExited", { msg: exitMessage })}
          </span>
          <button className="btn btn-restart" data-testid="restart-btn" onClick={() => void restartPi()}>
            <Icon name="refresh" className="ic-sm" />
            {t("status.restart")}
          </button>
          {stderrTail ? (
            <details className="exit-details" data-testid="exit-details">
              <summary title={t("status.exitDetailsTitle")}>{t("status.exitDetails")}</summary>
              <pre className="exit-details-body">{stderrTail}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      <div className="statusbar" data-testid="statusbar">
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
          <span className="status-ctx" data-testid="status-context" title={t("status.ctxTitle")}>
            <span className={`ctx-bar ctx-${ctxLevel}`} data-testid="status-context-bar">
              <span
                className="ctx-bar-fill"
                style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
              />
            </span>
            {t("status.ctx", { pct: Math.round(percent) })}
          </span>
        ) : null}
        {cost != null ? (
          <span className="status-opt" data-testid="status-cost" title={t("status.costTitle")}>
            ${cost.toFixed(4)}
          </span>
        ) : null}
        {totalMessages != null ? (
          <span className="status-opt" data-testid="status-messages">
            {t("status.msgs", { n: totalMessages })}
          </span>
        ) : null}
        {bridgeKind === "mock" ? (
          <span className="status-opt status-mock">MOCK</span>
        ) : null}
      </div>
      </div>
    </div>
  );
}
