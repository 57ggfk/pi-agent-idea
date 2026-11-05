import { useEffect, useMemo, useRef, useState } from "react";
import { usePiStore } from "../store/store";
import { outlineEntries } from "../lib/outline";
import { scrollToItem } from "../lib/scrollToItem";
import { useT } from "../i18n/useT";
import Icon from "./Icon";

/**
 * User-message outline (spec 006 US1): a floating list of every user message
 * in the session; clicking one scrolls the transcript to it and flashes it.
 * The panel stays open so the current entry can be seen moving as the user
 * scrolls (scroll position tracked with a plain rect scan — the message list
 * is the only scroll container).
 */
export default function SessionOutline() {
  const open = usePiStore((s) => s.outlineOpen);
  const items = usePiStore((s) => s.items);
  const toggleOutline = usePiStore((s) => s.toggleOutline);
  const { t } = useT();
  const entries = useMemo(() => outlineEntries(items), [items]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Track the entry nearest the viewport top while open. A rect scan on scroll
  // (rAF-throttled) — no IntersectionObserver machinery for one container.
  useEffect(() => {
    if (!open) return;
    const listEl = document.querySelector<HTMLElement>(".message-list");
    if (!listEl) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const listRect = listEl.getBoundingClientRect();
      let best: number | null = null;
      let bestTop = Number.POSITIVE_INFINITY;
      listEl.querySelectorAll<HTMLElement>(".item[data-item-id]").forEach((el) => {
        const top = el.getBoundingClientRect().top;
        if (top < listRect.top - el.offsetHeight) return; // fully above
        if (top < bestTop) {
          bestTop = top;
          best = Number(el.dataset.itemId);
        }
      });
      if (best != null) setCurrentId(best);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    listEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      listEl.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [open, entries]);

  if (!open || entries.length === 0) return null;

  const jump = (itemId: number) => {
    const listEl = document.querySelector<HTMLElement>(".message-list");
    if (!listEl) return;
    scrollToItem(listEl, itemId);
    setCurrentId(itemId);
  };

  return (
    <div className="session-outline" data-testid="session-outline" ref={listRef}>
      <div className="outline-head">
        <span className="outline-title">{t("chat.outline.title")}</span>
        <button
          type="button"
          className="outline-close"
          data-testid="outline-close"
          aria-label={t("chat.outline.close")}
          onClick={() => toggleOutline(false)}
        >
          <Icon name="x" className="ic-sm" />
        </button>
      </div>
      <div className="outline-list" role="listbox" aria-label={t("chat.outline.label")}>
        {entries.map((entry, i) => (
          <button
            key={entry.itemId}
            type="button"
            role="option"
            aria-selected={entry.itemId === currentId}
            className={`outline-item ${entry.itemId === currentId ? "outline-current" : ""}`}
            data-testid="outline-item"
            onClick={() => jump(entry.itemId)}
          >
            <span className="outline-n">#{i + 1}</span>
            <span className="outline-text">{entry.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
