import { useCallback, useEffect, useState } from "react";
import type { manageApi, AgentsEntry } from "../../manage";
import { useT } from "../../i18n/useT";

/**
 * AGENTS.md panel (012 US3, T119): every context-file location pi loads for
 * this project, in pi's own order — global `~/.pi/agent`, the project root,
 * then subdirectories. Open always; create writes a template when absent.
 * Content is never shown or parsed here (plan D4): editing happens in the IDE
 * editor, which keeps the panel decoupled from pi's file syntax.
 */
export default function AgentsPanel({
  api,
  trusted,
}: {
  api: ReturnType<typeof manageApi>;
  trusted: boolean | null;
}) {
  const { t } = useT();
  const [entries, setEntries] = useState<AgentsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await api.agentsList();
      setEntries(res.entries ?? []);
      if (!res.ok) setError(res.error ?? "agentsList failed");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = async (path: string) => {
    setNote(null);
    setBusy(true);
    try {
      const res = await api.agentsOpen({ path });
      if (!res.ok) setNote(res.error ?? null);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async (path: string) => {
    setNote(null);
    setBusy(true);
    try {
      const res = await api.agentsCreate({ path });
      if (res.ok) {
        await refresh();
        setNote(t("agents.created", { path: res.path ?? path }));
      } else {
        setNote(res.error ?? null);
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="agents-panel">
      {/* Project-local files only take effect once pi trusts the project (002
          PiTrust) — say so instead of letting the user wonder (plan D4 #3). */}
      {trusted === false ? (
        <div className="panel-note" data-testid="agents-untrusted">
          {t("agents.untrusted")}
        </div>
      ) : null}
      <div className="panel-toolbar">
        <span className="panel-row-sub">{t("agents.hint")}</span>
        <span className="spacer" />
        <button className="btn" data-testid="agents-refresh" onClick={() => void refresh()} disabled={busy}>
          {t("agents.refresh")}
        </button>
      </div>

      {error ? (
        <div className="panel-note" data-testid="agents-error">
          {error}
        </div>
      ) : null}
      {note ? (
        <div className="panel-note" data-testid="agents-note">
          {note}
        </div>
      ) : null}

      {entries?.length === 0 ? (
        <div className="panel-empty" data-testid="agents-empty">
          {t("agents.empty")}
        </div>
      ) : null}

      <div className="agents-list">
        {(entries ?? []).map((e) => (
          <div className="panel-row" data-testid="agents-row" key={`${e.scope}:${e.path}`}>
            <div className="panel-row-main">
              <span className="panel-row-title">
                <span className="agents-scope" data-testid={`agents-scope-${e.scope}`}>
                  {e.scope === "global"
                    ? t("agents.scope.global")
                    : e.scope === "root"
                      ? t("agents.scope.root")
                      : t("agents.scope.subdirectory")}
                </span>
                <span className="mono">{e.relativePath ? `${e.relativePath}/` : ""}{e.fileName}</span>
              </span>
              <span className="panel-row-sub">
                {e.exists ? t("agents.exists") : t("agents.missing")}
                {" · "}
                {t("agents.priority", { rank: e.priority })}
              </span>
              {/* T1509: path on its own line — full on wide panels, short form narrow. */}
              <div className="skill-path-line mono" title={e.path}>
                <span className="skill-path-full">{e.path}</span>
                <span className="skill-path-short">{e.displayPath ?? e.path}</span>
              </div>
            </div>
            <div className="panel-row-actions">
              {e.exists ? (
                <button
                  className="btn"
                  data-testid="agents-open"
                  disabled={busy}
                  onClick={() => void open(e.path)}
                >
                  {t("agents.open")}
                </button>
              ) : (
                <button
                  className="btn btn-send"
                  data-testid="agents-create"
                  disabled={busy}
                  onClick={() => void create(e.path)}
                >
                  {t("agents.create")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
