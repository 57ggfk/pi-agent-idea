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
 */
export default function SessionTitleInput({ testId }: { testId: string }) {
  const sessionName = usePiStore((s) => s.sessionName);
  const submitSessionTitle = usePiStore((s) => s.submitSessionTitle);
  const cancelEditSessionTitle = usePiStore((s) => s.cancelEditSessionTitle);
  const { t } = useT();
  const [draft, setDraft] = useState(sessionName ?? "");
  const [error, setError] = useState<null | "empty" | "long">(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guard against double-commit: blur fires right before/after Enter.
  const submittingRef = useRef(false);

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
    await submitSessionTitle(draft);
    // The store closes the editor on success; a failed RPC keeps it open so
    // the user can retry (the old name is untouched on screen).
  };

  return (
    <span className="session-title-editor">
      <input
        ref={inputRef}
        className="select session-title-input"
        data-testid={testId}
        value={draft}
        aria-label={t("sessions.renameTitle")}
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
      {error ? (
        <span className="session-title-error" data-testid="session-rename-error">
          {error === "empty" ? t("sessions.renameEmpty") : t("sessions.renameLong", { max: 32 })}
        </span>
      ) : null}
    </span>
  );
}
