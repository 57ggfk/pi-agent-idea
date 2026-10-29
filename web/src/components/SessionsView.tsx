import { useEffect, useState } from "react";
import { usePiStore } from "../store/store";

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
  const newSession = usePiStore((s) => s.newSession);
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
          className="select sessions-filter"
          data-testid="sessions-filter"
          placeholder="Filter sessions…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="btn" data-testid="sessions-new" onClick={() => void newSession()}>
          + New session
        </button>
      </div>
      <div className="sessions-list">
        {filtered.length === 0 ? (
          <div className="sessions-empty" data-testid="sessions-empty">
            No sessions found for this project.
          </div>
        ) : null}
        {filtered.map((s) => (
          <button
            key={s.file}
            className={`session-row ${s.id && s.id === sessionId ? "session-current" : ""}`}
            data-testid="session-row"
            onClick={() => void switchSession(s.file)}
            title={s.file}
          >
            <div className="session-row-top">
              <span className="session-name">{s.name || s.preview?.slice(0, 60) || s.id || "Untitled"}</span>
              <span className="session-time">{formatTime(s.modifiedAt)}</span>
            </div>
            <div className="session-preview">
              {s.name ? s.preview || s.id : s.id}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
