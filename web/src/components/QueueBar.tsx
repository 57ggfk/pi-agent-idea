import { useEffect, useState } from "react";
import { usePiStore } from "../store/store";
import type { QueueItem } from "../store/types";
import { useT } from "../i18n/useT";
import Icon from "./Icon";

/** Preview cap from plan decision 8 (spec Edge Case: 队列条目超长). */
const PREVIEW_MAX = 120;
/** Inline delete confirmation auto-reverts after this long (plan decision 6). */
const CONFIRM_MS = 2500;

function QueueRow({ item, index }: { item: QueueItem; index: number }) {
  const items = usePiStore((s) => s.queue.items);
  const move = usePiStore((s) => s.queueMove);
  const remove = usePiStore((s) => s.queueRemove);
  const restore = usePiStore((s) => s.queueRestore);
  const promote = usePiStore((s) => s.queuePromote);
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);

  // The inline confirm reverts on its own: a missed click must not leave a
  // destructive button armed forever (plan decision 6).
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  // Moves are section-local: pi keeps steering and follow-ups in two arrays,
  // so a swap across the boundary could not change the execution order and
  // would only be a displayed lie. Same rule disables the button.
  const upDisabled = index === 0 || items[index - 1].mode !== item.mode;
  const downDisabled = index === items.length - 1 || items[index + 1].mode !== item.mode;
  const previewText = (item: QueueItem): string => {
    const base = item.text.trim().length > 0 ? item.text : t("queue.imageOnly");
    const single = base.replace(/\s+/g, " ").trim();
    return single.length > PREVIEW_MAX ? `${single.slice(0, PREVIEW_MAX)}…` : single;
  };

  return (
    <div
      className={`queue-row ${item.status === "failed" ? "queue-row-failed" : ""}`}
      data-testid="queue-row"
      data-mode={item.mode}
      data-status={item.status}
    >
      <span className="queue-index mono">{index + 1}</span>
      <span className={`queue-mode queue-mode-${item.mode}`}>
        {item.mode === "steer" ? t("queue.mode.steer") : t("queue.mode.followUp")}
      </span>
      {item.images.length > 0 ? (
        <span
          className="queue-image-count"
          data-testid="queue-image-count"
          title={t("tool.images_other", { count: item.images.length })}
        >
          <Icon name="image" className="ic-sm" />
          {item.images.length}
        </span>
      ) : null}
      <span className="queue-preview" title={item.text}>
        {previewText(item)}
      </span>
      {item.status === "failed" ? (
        <span className="queue-error" data-testid="queue-error" title={item.error}>
          {item.error}
        </span>
      ) : null}
      <span className="queue-actions">
        <button
          className="btn btn-icon"
          data-testid={`queue-up-${index}`}
          title={t("queue.moveUp")}
          aria-label={t("queue.moveUpAria", { n: index + 1 })}
          disabled={upDisabled}
          onClick={() => void move(item.id, -1)}
        >
          ↑
        </button>
        <button
          className="btn btn-icon"
          data-testid={`queue-down-${index}`}
          title={t("queue.moveDown")}
          aria-label={t("queue.moveDownAria", { n: index + 1 })}
          disabled={downDisabled}
          onClick={() => void move(item.id, +1)}
        >
          ↓
        </button>
        <button
          className="btn btn-icon"
          data-testid={`queue-edit-${index}`}
          title={t("queue.takeBack")}
          aria-label={t("queue.editAria", { n: index + 1 })}
          onClick={() => void restore(item.id)}
        >
          ✎
        </button>
        {item.mode === "followUp" ? (
          <button
            className="btn btn-icon"
            data-testid={`queue-promote-${index}`}
            title={t("queue.steerInto")}
            aria-label={t("queue.steerAria", { n: index + 1 })}
            onClick={() => void promote(item.id)}
          >
            ⇧
          </button>
        ) : null}
        {confirming ? (
          <>
            <button
              className="btn btn-abort"
              data-testid={`queue-confirm-del-${index}`}
              onClick={() => {
                setConfirming(false);
                void remove(item.id);
              }}
            >
              {t("queue.confirmDelete")}
            </button>
            <button className="btn" data-testid={`queue-cancel-del-${index}`} onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </button>
          </>
        ) : (
          <button
            className="btn btn-icon btn-abort"
            data-testid={`queue-del-${index}`}
            title={t("queue.delete")}
            aria-label={t("queue.deleteAria", { n: index + 1 })}
            onClick={() => setConfirming(true)}
          >
            ✕
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * The queue bar between the message list and the composer (spec 005 FR-004).
 * Hidden entirely when nothing is queued — no empty panel residue (US2-4).
 */
export default function QueueBar() {
  const queue = usePiStore((s) => s.queue);
  const driftAck = usePiStore((s) => s.driftAck);
  const queueResume = usePiStore((s) => s.queueResume);
  const queueClear = usePiStore((s) => s.queueClear);
  const queueDismissDrift = usePiStore((s) => s.queueDismissDrift);
  const { t } = useT();

  if (queue.items.length === 0) return null;

  const pauseLabel =
    queue.pauseReason === "aborted"
      ? t("queue.pausedAborted")
      : queue.pauseReason === "pi-restarted"
        ? t("queue.pausedRestarted")
        : t("queue.paused");

  return (
    <div className="queue-bar" data-testid="queue-bar">
      {queue.drift && !driftAck ? (
        <div className="queue-banner queue-banner-drift" data-testid="queue-drift">
          <span>{t("queue.drift")}</span>
          <button className="link-btn" data-testid="queue-drift-dismiss" onClick={queueDismissDrift}>
            {t("common.close")}
          </button>
        </div>
      ) : null}
      {queue.paused ? (
        <div className="queue-banner queue-banner-paused" data-testid="queue-paused">
          <span>{pauseLabel}</span>
          <span className="queue-banner-hint">{t("queue.pausedHint")}</span>
          <button className="btn btn-send" data-testid="queue-resume" onClick={() => void queueResume()}>
            {t("queue.resume")}
          </button>
          <button className="btn btn-abort" data-testid="queue-clear" onClick={() => void queueClear()}>
            {t("queue.clear")}
          </button>
        </div>
      ) : null}
      {queue.items.map((item, i) => (
        <QueueRow key={item.id} item={item} index={i} />
      ))}
    </div>
  );
}

/** Session-change confirmation for a non-empty queue (spec 005 FR-012). */
export function QueueDiscardBanner() {
  const confirm = usePiStore((s) => s.queueDiscardConfirm);
  const confirmDiscard = usePiStore((s) => s.confirmQueueDiscard);
  const { t } = useT();
  if (!confirm) return null;
  return (
    <div className="queue-banner queue-banner-confirm" data-testid="queue-discard-confirm">
      <span>
        {t("queue.discard.body", {
          action: confirm.kind === "new" ? t("queue.discard.new") : t("queue.discard.switch"),
          count: confirm.count,
        })}
      </span>
      <button className="btn btn-abort" data-testid="queue-discard-yes" onClick={() => void confirmDiscard(true)}>
        {confirm.kind === "new" ? t("queue.discard.yes.new") : t("queue.discard.yes.switch")}
      </button>
      <button className="btn" data-testid="queue-discard-no" onClick={() => void confirmDiscard(false)}>
        {t("common.cancel")}
      </button>
    </div>
  );
}
