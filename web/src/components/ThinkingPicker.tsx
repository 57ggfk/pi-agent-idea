import { useEffect, useRef, useState } from "react";
import { usePiStore } from "../store/store";
import Icon from "./Icon";

/**
 * Bottom-bar thinking-level dropdown. The composer sits at the bottom of the
 * tool window, so the menu opens upward — a native <select> popup would open
 * downward and get clipped by the window edge.
 */
export default function ThinkingPicker() {
  const [open, setOpen] = useState(false);
  const thinkingLevel = usePiStore((s) => s.thinkingLevel);
  const thinkingLevels = usePiStore((s) => s.thinkingLevels);
  const setThinkingLevel = usePiStore((s) => s.setThinkingLevel);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Fall back to the current level so the menu is never empty.
  const levels = thinkingLevels.length > 0 ? thinkingLevels : [thinkingLevel];

  const pick = (level: string) => {
    void setThinkingLevel(level);
    setOpen(false);
  };

  return (
    <div className="thinking-picker" ref={rootRef}>
      <button
        className="select"
        data-testid="thinking-select"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        title={`Thinking level: ${thinkingLevel}`}
        aria-label={`Thinking level: ${thinkingLevel}`}
      >
        <Icon name="gauge" className="ic-sm" />
        <span className="chip-label">{thinkingLevel}</span>
        <Icon name="chev-down" className="ic-sm chip-caret" />
      </button>
      {open ? (
        <div className="thinking-menu" data-testid="thinking-menu">
          {levels.map((level) => (
            <div
              key={level}
              className={`slash-item ${level === thinkingLevel ? "slash-active" : ""}`}
              data-testid={`thinking-option-${level}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(level);
              }}
            >
              <span className="thinking-check">{level === thinkingLevel ? "✓" : ""}</span>
              <span className="slash-name">{level}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
