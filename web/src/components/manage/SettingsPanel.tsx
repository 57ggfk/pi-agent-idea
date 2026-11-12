import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/useT";
import { OutcomeBanner } from "../ManageView";
import type { manageApi } from "../../manage";

export default function SettingsPanel({ api }: { api: ReturnType<typeof manageApi> }) {
  const { t } = useT();
  const [path, setPath] = useState("");
  const [text, setText] = useState("{}");
  const [outcome, setOutcome] = useState<{ ok: boolean; error?: string; output?: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [snapshot, setSnapshot] = useState<{ text: string; collectedAt: string } | null>(null);
  const [snapshotOff, setSnapshotOff] = useState(false);
  const [snapshotEmpty, setSnapshotEmpty] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.settingsRead();
      setPath(res.path ?? "");
      setText(res.text ?? "{}");
      setDirty(false);
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 032 Q6-b: the read-only viewer. The call refreshes the snapshot on the
  // IDE side, so what is shown is exactly what the next turn would inject.
  const loadSnapshot = useCallback(async () => {
    try {
      const res = await api.envSnapshot();
      if (res.ok) {
        setSnapshotOff(res.enabled === false);
        if (res.text && res.text.trim().length > 0) {
          setSnapshot({ text: res.text, collectedAt: res.collectedAt ?? "" });
          setSnapshotEmpty(false);
        } else {
          setSnapshot(null);
          setSnapshotEmpty(true);
        }
      }
    } catch {
      // best-effort viewer: a failed snapshot read never surfaces as an error
    }
  }, [api]);

  const save = async () => {
    setOutcome(null);
    try {
      const res = await api.settingsWrite({ text });
      setOutcome(res.ok ? { ok: true, output: t("settings.saved", { path: res.output ?? "" }) } : { ok: false, error: res.error });
      if (res.ok) setDirty(false);
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    }
  };

  return (
    <div data-testid="settings-panel">
      <OutcomeBanner outcome={outcome} />
      <div className="panel-toolbar">
        <span className="panel-row-sub mono">{path}</span>
        <span className="spacer" />
        <button className="btn" data-testid="settings-reload" onClick={() => void refresh()}>
          {t("settings.reload")}
        </button>
        <button
          className="btn btn-send"
          data-testid="settings-save"
          onClick={() => void save()}
          disabled={!dirty}
        >
          {t("settings.save")}
        </button>
      </div>
      <textarea
        className="settings-editor"
        data-testid="settings-editor"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
      />
      <div className="panel-row-sub">
        Restart the pi process (Chat → + New does not suffice; use project reopen or pi /reload) after changing settings.
      </div>
      <div className="panel-toolbar">
        <button className="btn" data-testid="env-snapshot-btn" onClick={() => void loadSnapshot()}>
          {t("settings.envSnapshot")}
        </button>
        {snapshot ? <span className="panel-row-sub mono">{snapshot.collectedAt}</span> : null}
      </div>
      {snapshot ? (
        <pre className="env-snapshot" data-testid="env-snapshot-text">
          {snapshot.text}
        </pre>
      ) : snapshotOff ? (
        <div className="panel-row-sub" data-testid="env-snapshot-off">
          {t("settings.envSnapshotOff")}
        </div>
      ) : snapshotEmpty ? (
        <div className="panel-row-sub" data-testid="env-snapshot-empty">
          {t("settings.envSnapshotEmpty")}
        </div>
      ) : null}
    </div>
  );
}
