import { useEffect, useRef, useState } from "react";
import { usePiStore } from "../store/store";

interface RowProps {
  label: string;
  testId: string;
  checked: boolean;
  onToggle(): void;
  hint?: string;
}

function OptionRow({ label, testId, checked, onToggle, hint }: RowProps) {
  // Plain div, not a <label>: label-wrapped switches re-dispatch clicks and
  // confuse both pointer automation and double-toggle handling.
  return (
    <div className="options-row" data-testid={testId} title={hint}>
      <span className="options-label">{label}</span>
      <button
        type="button"
        className={`switch ${checked ? "switch-on" : ""}`}
        data-testid={`${testId}-toggle`}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onToggle()}
      >
        <span className="knob" />
      </button>
    </div>
  );
}

/**
 * Bottom-bar options menu (opens upward, mirroring the thinking picker):
 * pi-managed toggles plus the tool-approval mode of the bundled extension.
 */
export default function OptionsPopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const approvalMode = usePiStore((s) => s.approvalMode);
  const setApprovalMode = usePiStore((s) => s.setApprovalMode);
  const autoCompaction = usePiStore((s) => s.autoCompaction);
  const setAutoCompaction = usePiStore((s) => s.setAutoCompaction);
  const autoRetry = usePiStore((s) => s.autoRetry);
  const setAutoRetry = usePiStore((s) => s.setAutoRetry);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="options-picker" ref={rootRef}>
      <button
        className="btn"
        data-testid="options-btn"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        title="Agent options"
      >
        ⚙ Options
      </button>
      {open ? (
        <div className="options-menu" data-testid="options-menu">
          <OptionRow
            label="Auto-compact context"
            testId="opt-auto-compaction"
            checked={autoCompaction ?? true}
            hint="Compact the context automatically when it fills up"
            onToggle={() => void setAutoCompaction(!(autoCompaction ?? true))}
          />
          <OptionRow
            label="Auto-retry on errors"
            testId="opt-auto-retry"
            checked={autoRetry ?? true}
            hint="Retry transient provider errors (rate limit, 5xx) automatically"
            onToggle={() => void setAutoRetry(!(autoRetry ?? true))}
          />
          <OptionRow
            label="Tool approval (ask before edits & commands)"
            testId="opt-approval"
            checked={approvalMode === "ask"}
            hint={
              approvalMode === "ask"
                ? "Read-only tools run freely; mutating tools wait for your approval"
                : "Yolo: tools run without asking"
            }
            onToggle={() => void setApprovalMode(approvalMode === "ask" ? "yolo" : "ask")}
          />
        </div>
      ) : null}
    </div>
  );
}
