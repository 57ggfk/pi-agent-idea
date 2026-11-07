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
    </div>
  );
}
