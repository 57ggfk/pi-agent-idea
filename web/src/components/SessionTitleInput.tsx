import { useEffect, useRef, useState } from "react";
import { usePiStore } from "../store/store";
import { validateSessionTitle } from "../lib/sessionTitle";
import { useT } from "../i18n/useT";

/**
 * The single inline title editor (012 T107/T108).
 *
 * The status bar and the current session row both render this when
 * `editingSessionTitle` is on — the store guarantees at most one editor, and
 * the two hosts place it by tab, so two inputs can never appear at once.
 * Enter/blur commits, Esc cancels, and an invalid name shows why and keeps
 * the old title untouched.
 *
 * Two variants: "row" (sessions list — has vertical room, the error renders
 * under the input) and "bar" (status bar — strictly one line, so an error
 * marks the input red and explains itself via tooltip instead of a second
 * row that would stretch the whole bar).
 */
export default function SessionTitleInput({
  testId,
  variant = "row",
  initialName,
}: {
  testId: string;
  variant?: "row" | "bar";
  /** Prefill for a specific row; defaults to the live session's name. */
  initialName?: string;
}) {
  const sessionName = usePiStore((s) => s.sessionName);
  const submitSessionTitle = usePiStore((s) => s.submitSessionTitle);
  const cancelEditSessionTitle = usePiStore((s) => s.cancelEditSessionTitle);
  const { t } = useT();
  const [draft, setDraft] = useState(initialName ?? sessionName ?? "");
  const [error, setError] = useState<null | "empty" | "long" | "failed">(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guard against double-commit: blur fires right before/after Enter.
  const submittingRef = useRef(false);

  const errorText =
    error === "empty"
      ? t("sessions.renameEmpty")
      : error === "long"
        ? t("sessions.renameLong", { max: 32 })
        : error === "failed"
          ? t("sessions.renameFailed")
          : null;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    const verdict = validateSessionTitle(draft);
    if (verdict !== "ok") {
      setError(verdict);
      submittingRef.current = false;
      inputRef.current?.focus();
      return;
    }
    setError(null);
    const outcome = await submitSessionTitle(draft);
    if (outcome === "failed") {
      // The store keeps the editor open on failure; surface why so a silent
      // input is never the only signal.
      setError("failed");
      submittingRef.current = false;
      inputRef.current?.focus();
    }
    // The store closes the editor on success; the old name is untouched.
  };

  return (
    <span className="session-title-editor">
      <input
        ref={inputRef}
        className={`select session-title-input${variant === "bar" ? " session-title-input-bar" : ""}`}
        data-testid={testId}
        value={draft}
        aria-label={t("sessions.renameTitle")}
        aria-invalid={error ? true : undefined}
        title={variant === "bar" ? (errorText ?? undefined) : undefined}
        maxLength={200}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelEditSessionTitle();
          }
        }}
      />
      {variant === "bar" ? null : error ? (
        <span className="session-title-error" data-testid="session-rename-error">
          {errorText}
        </span>
      ) : null}
    </span>
  );
}
