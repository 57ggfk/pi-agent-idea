import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { useT } from "../i18n/useT";
import { selectedNumbers, splitQuestion, toggleOptionNumber } from "../lib/approvalQuestion";
import { usePiStore } from "../store/store";
import Icon from "./Icon";

/**
 * Pending extension_ui_request dialogs forwarded by pi (see pi's
 * docs/rpc-extension-ui.md). Rendered above the composer; the agent run is
 * blocked until the user answers, cancels, or pi's own timeout resolves it.
 *
 * All four dialog methods are supported rather than only `confirm`: an
 * `input`/`editor` question rendered as a yes/no pair used to be a trap, since
 * both buttons sent `cancelled: true` and the extension got `undefined`.
 *
 * pi's RPC has no multi-select, so extensions that need one (e.g.
 * rpiv-ask-user-question) degrade to `input` with the numbered options written
 * into the title. Those lines are lifted out into clickable entries here — but
 * only as a typing shortcut: an entry writes its number into the same field the
 * user can edit, and the field text is what gets sent, so a mis-detected list
 * costs nothing.
 */
export default function ApprovalCard() {
  const { t } = useT();
  const approvals = usePiStore((s) => s.approvals);
  const respondApproval = usePiStore((s) => s.respondApproval);
  // pi blocks inside its tool_call hook, so requests queue one at a time.
  const a = approvals[0];
  const [text, setText] = useState("");
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // 换到下一问时重置输入：editor 的 prefill 属于这一问，input 总是从空开始。
  useEffect(() => {
    setText(a?.method === "editor" ? (a.prefill ?? "") : "");
  }, [a?.id, a?.method, a?.prefill]);

  // 卡片一出现就能直接打字，不必先点输入框。
  useEffect(() => {
    if (!a) return;
    if (a.method === "input" || a.method === "editor") fieldRef.current?.focus();
  }, [a?.id, a?.method]);

  const asked = useMemo(() => (a?.method === "input" ? splitQuestion(a.title) : null), [a?.method, a?.title]);
  const options = asked?.options ?? [];
  const multi = options.length >= 2;
  const picked = multi ? selectedNumbers(text) : [];

  if (!a) return null;

  const cancel = () => void respondApproval(a.id, null);
  const submit = () => {
    if (text.trim().length === 0) return;
    void respondApproval(a.id, text);
  };
  // 输入法组词时的回车是「确认候选词」，不是「提交」。
  const composing = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => e.nativeEvent.isComposing;

  return (
    <div className="approval-card" data-testid="approval-card" data-method={a.method}>
      <div className="approval-title" data-testid="approval-title">
        <Icon name="shield" className="ic-sm approval-icon" />
        <span>{(multi ? asked?.question : a.title) || t("approval.titleFallback")}</span>
      </div>
      {a.message ? (
        <pre className="approval-message" data-testid="approval-message">
          {a.message}
        </pre>
      ) : null}

      {a.method === "select" && a.options?.length ? (
        <div className="approval-options" data-testid="approval-options">
          {a.options.map((option) => (
            <button
              key={option}
              className="btn approval-option"
              data-testid="approval-option"
              onClick={() => void respondApproval(a.id, option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}

      {multi ? (
        <div className="approval-options" data-testid="approval-picks">
          {options.map((option) => {
            const on = picked.includes(option.n);
            return (
              <button
                key={option.n}
                type="button"
                className={`btn approval-option ${on ? "approval-option-on" : ""}`}
                data-testid="approval-pick"
                aria-pressed={on}
                title={option.desc}
                onClick={() => setText((current) => toggleOptionNumber(current, option.n))}
              >
                <span className="approval-pick-n">{option.n}</span>
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {a.method === "input" ? (
        <input
          ref={fieldRef as RefObject<HTMLInputElement>}
          className="approval-input"
          data-testid="approval-input"
          value={text}
          placeholder={a.placeholder || t("approval.inputPlaceholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !composing(e)) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              cancel();
            }
          }}
        />
      ) : null}

      {multi ? (
        <div className="approval-hint" data-testid="approval-hint">
          {t("approval.multiHint")}
        </div>
      ) : null}

      {a.method === "editor" ? (
        <textarea
          ref={fieldRef as RefObject<HTMLTextAreaElement>}
          className="approval-editor"
          data-testid="approval-editor"
          rows={4}
          value={text}
          placeholder={a.placeholder || t("approval.editorPlaceholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel();
          }}
        />
      ) : null}

      {approvals.length > 1 ? (
        <div className="approval-queued" data-testid="approval-queued">
          {t("approval.queued", { n: approvals.length - 1 })}
        </div>
      ) : null}

      <div className="approval-actions">
        {a.method === "confirm" ? (
          <>
            <button
              className="btn btn-approve"
              data-testid="approval-allow"
              onClick={() => void respondApproval(a.id, true)}
            >
              {t("approval.allow")}
            </button>
            <button
              className="btn btn-deny"
              data-testid="approval-deny"
              onClick={() => void respondApproval(a.id, false)}
            >
              {t("approval.deny")}
            </button>
          </>
        ) : (
          <>
            {a.method !== "select" ? (
              <button
                className="btn btn-approve"
                data-testid="approval-submit"
                disabled={text.trim().length === 0}
                onClick={submit}
              >
                {t("approval.submit")}
              </button>
            ) : null}
            <button className="btn" data-testid="approval-cancel" onClick={cancel}>
              {t("approval.cancel")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
