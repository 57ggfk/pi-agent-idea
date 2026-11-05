import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePiStore } from "../store/store";

/** Elements the Tab key is allowed to land on inside the dialog. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one confirmation dialog (spec 007 US3).
 *
 * Mounted once by App inside `.app`, so it is scoped to the tool window rather
 * than to the JCEF viewport — a `window.confirm` here would be an unstyled
 * native sheet that also cannot be translated by 008.
 *
 * Behaviour the spec pins down:
 *  - FR-009: `role="dialog"` + `aria-modal` + a real title, Esc cancels,
 *    Enter confirms, Tab cycles inside, the primary button owns focus on open.
 *  - FR-010: the overlay swallows clicks and wheel events, so neither the
 *    message list nor the page scrolls behind it.
 */
export default function ConfirmDialog() {
  const request = usePiStore((s) => s.confirm);
  const closeConfirm = usePiStore((s) => s.closeConfirm);
  const dialogRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    if (!request || busy) return;
    setBusy(true);
    // Close first: the confirmed action may open another dialog (the queue
    // discard path) and a stale instance would otherwise stay on top.
    closeConfirm();
    try {
      await request.onConfirm();
    } finally {
      setBusy(false);
    }
  }, [request, busy, closeConfirm]);

  // Focus the primary action on open (FR-009). Layout effect, not rAF: focus
  // has to be in place before the first key press, otherwise Enter typed right
  // after opening would re-activate whatever button the user came from.
  useLayoutEffect(() => {
    if (!request) return;
    okRef.current?.focus();
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeConfirm();
        return;
      }
      if (event.key === "Enter") {
        // A focused button already activates on Enter by itself; intercepting
        // it here would fire the action twice (or override Cancel).
        if (document.activeElement instanceof HTMLButtonElement) return;
        event.preventDefault();
        void run();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const targets = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (targets.length === 0) return;
      const first = targets[0];
      const last = targets[targets.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // Capture phase: the composer textarea must not see these keys first.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [request, closeConfirm, run]);

  if (!request) return null;

  return (
    <div
      className="confirm-scrim"
      data-testid="confirm-scrim"
      onClick={() => closeConfirm()}
      onWheel={(event) => event.preventDefault()}
      role="presentation"
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        data-testid="confirm-dialog"
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-title" id="confirm-title" data-testid="confirm-title">
          {request.title}
        </div>
        <div className="confirm-message" id="confirm-message" data-testid="confirm-message">
          {request.message}
        </div>
        <div className="confirm-actions">
          <button
            type="button"
            className="btn confirm-cancel"
            data-testid="confirm-cancel"
            onClick={() => closeConfirm()}
          >
            {request.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            className={`btn confirm-ok ${request.danger ? "confirm-danger" : "confirm-primary"}`}
            data-testid="confirm-ok"
            ref={okRef}
            onClick={() => void run()}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
