import { useEffect, useState } from "react";
import { usePiStore } from "../store/store";
import Icon from "./Icon";

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SessionsView() {
  const sessions = usePiStore((s) => s.sessions);
  const refreshSessions = usePiStore((s) => s.refreshSessions);
  const switchSession = usePiStore((s) => s.switchSession);
  const sessionId = usePiStore((s) => s.sessionId);
  const deleteSession = usePiStore((s) => s.deleteSession);
  const cloneSession = usePiStore((s) => s.cloneSession);
  const exportSession = usePiStore((s) => s.exportSession);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const filtered = sessions.filter((s) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.preview.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q)
    );
  });

  return (
    <div className="sessions-view" data-testid="sessions-view">
      <div className="sessions-toolbar">
        <input
          className="sessions-filter-input"
          data-testid="sessions-filter"
          placeholder="Filter sessions…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="sessions-list">
        {filtered.length === 0 ? (
          <div className="sessions-empty" data-testid="sessions-empty">
            No sessions found for this project.
          </div>
        ) : null}
        {filtered.map((s) => (
          <div
            key={s.file}
            className={`session-row ${s.id && s.id === sessionId ? "session-current" : ""}`}
            data-testid="session-row"
            title={s.file}
          >
            <button className="session-row-main" onClick={() => void switchSession(s.file)}>
              <div className="session-row-top">
                <span className="session-name">{s.name || s.preview?.slice(0, 60) || s.id || "Untitled"}</span>
                <span className="session-time">{formatTime(s.modifiedAt)}</span>
              </div>
              <div className="session-preview">
                {s.name ? s.preview || s.id : s.id}
                {typeof s.messageCount === "number" ? ` · ${s.messageCount} msgs` : ""}
              </div>
            </button>
            <div className="session-actions">
              <button
                className="btn session-action"
                data-testid="session-clone"
                title="Clone this session"
                onClick={() => void cloneSession(s.file)}
              >
                <Icon name="copy" className="ic-sm" />
              </button>
              <button
                className="btn session-action"
                data-testid="session-export"
                title="Export as HTML"
                onClick={() => void exportSession(s.file)}
              >
                <Icon name="download" className="ic-sm" />
              </button>
              <button
                className="btn session-action"
                data-testid="session-delete"
                title="Delete this session"
                onClick={() => {
                  // The store asks through the in-app dialog (007 US3), so the
                  // wording and the danger colour are consistent everywhere.
                  void deleteSession(s.file);
                }}
              >
                <Icon name="trash" className="ic-sm" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
