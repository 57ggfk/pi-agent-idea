import { useEffect, useRef, useState } from "react";
import type { SendMode } from "../store/store";

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
}: {
  mode: SendMode;
  setMode: (m: SendMode) => void;
  onMain: () => void;
  disabled: boolean;
  isStreaming: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
    { id: "auto", label: "Send now", hint: "Immediate prompt", enabled: !isStreaming },
    { id: "steer", label: "Steer", hint: "Deliver after the current tool round", enabled: isStreaming },
    { id: "followUp", label: "Follow-up", hint: "Deliver when the run finishes", enabled: isStreaming },
  ];

  const activeLabel = modes.find((m) => m.id === mode)?.label ?? "Send now";

  return (
    <div className="split-btn" ref={rootRef}>
      <button
        className="btn btn-send split-main"
        data-testid="send-btn"
        onClick={onMain}
        disabled={disabled}
        title={isStreaming ? `Send as ${activeLabel}` : "Send"}
      >
        Send
      </button>
      <button
        className={`btn btn-send split-caret ${isStreaming ? "" : "split-caret-disabled"}`}
        data-testid="send-mode-caret"
        aria-label="Queue mode"
        disabled={!isStreaming}
        title={isStreaming ? "Queue mode" : "Queue modes apply while the agent is running"}
        onClick={() => setMenuOpen((o) => !o)}
      >
        ▾
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
