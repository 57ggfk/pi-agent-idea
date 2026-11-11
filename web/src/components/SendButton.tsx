import { useEffect, useRef, useState } from "react";
import type { SendMode } from "../store/store";
import { useT } from "../i18n/useT";
import Icon from "./Icon";

/**
 * Split Send button: the main area sends with the selected queue mode, the
 * caret opens the mode dropdown (Auto / Steer / Follow-up).
 *
 * Queue modes only apply while the agent is running — the caret is rendered
 * grayed-out (disabled) when idle instead of being hidden.
 */
export default function SendButton({
  mode,
  setMode,
  onMain,
  disabled,
  isStreaming,
  blockedHint,
}: {
  mode: SendMode;
  setMode: (m: SendMode) => void;
  onMain: () => void;
  disabled: boolean;
  isStreaming: boolean;
  /** 021 T304: why sending is blocked right now (e.g. `session.switching`),
   *  shown instead of the plain label so a disabled button is never a mystery. */
  blockedHint?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { t } = useT();

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  // When a run starts, Auto is not a valid queue mode — default to Steer.
  useEffect(() => {
    if (isStreaming && mode === "auto") setMode("steer");
  }, [isStreaming, mode, setMode]);

  const modes: Array<{ id: SendMode; label: string; hint: string; enabled: boolean }> = [
    { id: "auto", label: t("send.mode.auto"), hint: t("send.mode.autoHint"), enabled: !isStreaming },
    { id: "steer", label: t("send.mode.steer"), hint: t("send.mode.steerHint"), enabled: isStreaming },
    { id: "followUp", label: t("send.mode.followUp"), hint: t("send.mode.followUpHint"), enabled: isStreaming },
  ];

  const activeLabel = modes.find((m) => m.id === mode)?.label ?? t("send.mode.auto");

  return (
    <div className="split-btn" ref={rootRef}>
      <button
        className="send-btn split-main"
        data-testid="send-btn"
        aria-label={t("send.label")}
        onClick={onMain}
        disabled={disabled}
        title={blockedHint ?? (isStreaming ? `${t("send.label")} · ${activeLabel}` : t("send.label"))}
      >
        <Icon name="arrow-up" />
      </button>
      <button
        className={`send-btn split-caret ${isStreaming ? "" : "split-caret-disabled"}`}
        data-testid="send-mode-caret"
        aria-label={t("send.queueMode")}
        disabled={!isStreaming}
        title={isStreaming ? t("send.queueMode") : t("send.queueModeHint")}
        onClick={() => setMenuOpen((o) => !o)}
      >
        <Icon name="chev-down" className="ic-sm" />
      </button>
      {menuOpen ? (
        <div className="send-mode-menu" data-testid="send-mode-menu">
          {modes.map((m) => (
            <div
              key={m.id}
              className={`slash-item ${m.id === mode ? "slash-active" : ""} ${m.enabled ? "" : "mode-disabled"}`}
              data-testid={`send-mode-${m.id}`}
              aria-disabled={!m.enabled}
              onMouseDown={(e) => {
                e.preventDefault();
                if (!m.enabled) return;
                setMode(m.id);
                setMenuOpen(false);
              }}
            >
              <span className="slash-name">{m.label}</span>
              <span className="slash-desc">{m.hint}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
