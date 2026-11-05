import { useEffect, useRef, useState } from "react";
import { usePiStore } from "../store/store";
import type { SessionSearchMatch } from "../store/store";
import { useT } from "../i18n/useT";
import { formatDateTime } from "../i18n/format";
import Icon from "./Icon";

/** Highlights every literal occurrence of `query` inside `text`. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: Array<{ at: number; end: number }> = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(target, from);
    if (at < 0) break;
    parts.push({ at, end: at + target.length });
    from = at + target.length;
  }
  if (parts.length === 0) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {text.slice(i === 0 ? 0 : parts[i - 1].end, p.at)}
          <mark className="session-hit-mark">{text.slice(p.at, p.end)}</mark>
          {i === parts.length - 1 ? text.slice(p.end) : null}
        </span>
      ))}
    </>
  );
}

export default function SessionsView() {
  const sessions = usePiStore((s) => s.sessions);
  const refreshSessions = usePiStore((s) => s.refreshSessions);
  const switchSession = usePiStore((s) => s.switchSession);
  const sessionId = usePiStore((s) => s.sessionId);
  const deleteSession = usePiStore((s) => s.deleteSession);
  const cloneSession = usePiStore((s) => s.cloneSession);
  const exportSession = usePiStore((s) => s.exportSession);
  const sessionSearch = usePiStore((s) => s.sessionSearch);
  const searchAllSessions = usePiStore((s) => s.searchAllSessions);
  const clearSessionSearch = usePiStore((s) => s.clearSessionSearch);
  const requestSearchJump = usePiStore((s) => s.requestSearchJump);
  const { t, language } = useT();
  const [filter, setFilter] = useState("");
  const debounceRef = useRef<number>(0);
  const formatTime = (ms: number) => formatDateTime(ms, language);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // Full-session body search: ≥2 chars, debounced (FR-010). The store owns
  // the race guard; typing fast can never flash an older result.
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    const q = filter.trim();
    if (q.length < 2) {
      clearSessionSearch();
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      void searchAllSessions(q);
    }, 250);
    return () => window.clearTimeout(debounceRef.current);
  }, [filter, searchAllSessions, clearSessionSearch]);

  const filtered = sessions.filter((s) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.preview.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q)
    );
  });

  /** A hit click: switch session, then land on that exact hit in the chat. */
  const openHit = (match: SessionSearchMatch, hitIndex: number) => {
    void switchSession(match.file).then(() => {
      requestSearchJump(filter.trim(), hitIndex);
    });
  };

  return (
    <div className="sessions-view" data-testid="sessions-view">
      <div className="sessions-toolbar">
        <input
          className="sessions-filter-input"
          data-testid="sessions-filter"
          placeholder={t("sessions.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {sessionSearch && filter.trim().length >= 2 ? (
        <div className="session-search-results" data-testid="session-search-results">
          {sessionSearch.results.length === 0 ? (
            <div className="sessions-empty" data-testid="sessions-search-empty">
              {t("sessions.noMatches_other", { count: sessionSearch.scanned })}
              {sessionSearch.truncated ? ` ${t("sessions.truncated")}` : ""}
            </div>
          ) : (
            <>
              {sessionSearch.truncated ? (
                <div className="session-search-note" data-testid="sessions-search-truncated">
                  {t("sessions.scannedNote", { count: sessionSearch.scanned })}
                </div>
              ) : null}
              {sessionSearch.results.map((match) => (
                <div key={match.file} className="session-search-hit" data-testid="session-search-hit">
                  <div className="session-hit-head">
                    <span className="session-name">{match.name || match.id || "Untitled"}</span>
                    <span className="session-hit-count" data-testid="session-hit-count">
                      {t("sessions.hits_other", { count: match.hitCount })}
                    </span>
                  </div>
                  {match.hits.map((hit) => (
                    <button
                      key={hit.hitIndex}
                      type="button"
                      className="session-hit-snippet"
                      data-testid="session-hit-snippet"
                      onClick={() => openHit(match, hit.hitIndex)}
                    >
                      <span className="session-hit-role">{hit.role}</span>
                      <span className="session-hit-text">
                        <Highlighted text={hit.snippet} query={filter} />
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}

      <div className="sessions-list">
        {filtered.length === 0 ? (
          <div className="sessions-empty" data-testid="sessions-empty">
            {t("sessions.empty")}
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
                {typeof s.messageCount === "number" ? ` · ${t("sessions.msgCount_other", { count: s.messageCount })}` : ""}
              </div>
            </button>
            <div className="session-actions">
              <button
                className="btn session-action"
                data-testid="session-clone"
                title={t("sessions.cloneTitle")}
                onClick={() => void cloneSession(s.file)}
              >
                <Icon name="copy" className="ic-sm" />
              </button>
              <button
                className="btn session-action"
                data-testid="session-export"
                title={t("sessions.exportTitle")}
                onClick={() => void exportSession(s.file)}
              >
                <Icon name="download" className="ic-sm" />
              </button>
              <button
                className="btn session-action"
                data-testid="session-delete"
                title={t("sessions.deleteTitle")}
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
