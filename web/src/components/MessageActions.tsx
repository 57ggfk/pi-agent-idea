import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { usePiStore } from "../store/store";
import { itemToMarkdownSource, type ChatItem, type MessageAction } from "../store/types";
import { useT } from "../i18n/useT";
import Icon, { type IconName } from "./Icon";

/** How long the copy button keeps its ✓ / ✗ before reverting (FR-004: ≥1s). */
const FLASH_MS = 1200;

const ICON: Record<MessageAction, IconName> = {
  copy: "copy",
  quote: "message",
  fork: "fork",
  regenerate: "refresh",
  edit: "pencil",
};

type CopyState = "idle" | "ok" | "fail";

/**
 * The hover toolbar. `actions` comes straight from `actionsForItem`, so this
 * component never decides *whether* a button applies — only how it looks and
 * what it does. Adding a condition here would create the second source of
 * truth the matrix exists to prevent.
 */
export default function MessageActions({ item, actions }: { item: ChatItem; actions: MessageAction[] }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useT();
  const quoteToComposer = usePiStore((s) => s.quoteToComposer);
  const regenerate = usePiStore((s) => s.regenerate);
  const beginEditMessage = usePiStore((s) => s.beginEditMessage);
  const forkAtItem = usePiStore((s) => s.forkAtItem);

  const LABEL: Record<MessageAction, string> = {
    copy: t("chat.actions.copy"),
    quote: t("chat.actions.quote"),
    fork: t("chat.actions.fork"),
    regenerate: t("chat.actions.regenerate"),
    edit: t("chat.actions.edit"),
  };

  const TITLE: Record<MessageAction, string> = {
    copy: t("chat.actions.copyTitle"),
    quote: t("chat.actions.quoteTitle"),
    fork: t("chat.actions.forkTitle"),
    regenerate: t("chat.actions.regenerateTitle"),
    edit: t("chat.actions.editTitle"),
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (actions.length === 0) return null;

  const flash = (result: CopyState) => {
    setCopyState(result);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState("idle"), FLASH_MS);
  };

  const onCopy = async () => {
    // Read the source at click time: a streaming block may have changed since
    // render, and a copy of stale text is worse than waiting.
    const source = itemToMarkdownSource(item) ?? "";
    flash((await copyText(source)) ? "ok" : "fail");
  };

  const onClick = (action: MessageAction) => {
    if (action === "copy") return void onCopy();
    if (action === "quote") return quoteToComposer(item);
    if (action === "fork") return void forkAtItem(item.id);
    if (action === "regenerate") return void regenerate();
    return void beginEditMessage(item);
  };

  return (
    <div className="msg-actions" data-testid="msg-actions" role="group" aria-label={t("chat.actions.group")}>
      {actions.map((action) => {
        const state = action === "copy" ? copyState : "idle";
        const label =
          state === "ok" ? t("chat.actions.copied") : state === "fail" ? t("chat.actions.copyFailed") : LABEL[action];
        return (
          <button
            key={action}
            type="button"
            className={`icon-btn msg-act ${state === "fail" ? "msg-act-fail" : ""}`}
            data-testid={`act-${action}`}
            data-state={state}
            aria-label={label}
            title={
              state === "ok"
                ? t("chat.actions.copied")
                : state === "fail"
                  ? t("chat.actions.copyFailed")
                  : TITLE[action]
            }
            onClick={() => onClick(action)}
          >
            <Icon
              name={state === "ok" ? "check" : state === "fail" ? "alert" : ICON[action]}
              className="ic-sm"
            />
          </button>
        );
      })}
    </div>
  );
}
