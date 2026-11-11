import { memo, useEffect, useMemo, useRef, useState } from "react";
import { SWITCH_LONG_MS, isSwitchLong, usePiStore } from "../store/store";
import { actionsForItem, type ChatItem, type ContentBlock, type MessageAction } from "../store/types";
import { hitsFromItems } from "../lib/search";
import { displaySkillText } from "../lib/skillDisplay";
import { imageSrc } from "../lib/imagePreview";
import { sameActionIds } from "../lib/messageActions";
import { initialPin, nextPin, type PinState } from "../lib/pin";
import { perfMark } from "../lib/perf";
import { useT } from "../i18n/useT";
import Markdown from "./Markdown";
import MessageActions from "./MessageActions";
import ToolCard from "./ToolCard";
import Icon from "./Icon";

function BlockView({
  block,
  forceOpenOutput,
  itemId,
  blockIndex,
}: {
  block: ContentBlock;
  forceOpenOutput?: boolean;
  itemId: number;
  blockIndex: number;
}) {
  const [open, setOpen] = useState(false);
  const openImagePreview = usePiStore((s) => s.openImagePreview);
  if (block.kind === "text") {
    if (!block.text) return null;
    return <Markdown text={block.text} />;
  }
  if (block.kind === "image") {
    if (!block.data) return null;
    // T139: the thumbnail IS the preview trigger — no second, larger node is
    // ever rendered; the modal reuses the same base64 payload.
    return (
      <img
        className="msg-image msg-image-clickable"
        src={imageSrc(block.data, block.mimeType)}
        alt="attached image"
        data-testid="msg-image"
        onClick={() => openImagePreview(itemId, blockIndex)}
      />
    );
  }
  if (block.kind === "thinking") {
    const streaming = !block.done;
    return (
      <div className={`thinking-block ${open ? "thinking-open" : ""}`} data-testid="thinking-block">
        <button
          type="button"
          className="thinking-head"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="sparkles" className="ic-sm" />
          <span className="thinking-label">Thinking{streaming ? "…" : ""}</span>
          <Icon name="chev" className="ic-sm thinking-chevron" />
        </button>
        {open && <div className="thinking-body">{block.text}</div>}
      </div>
    );
  }
  return <ToolCard block={block} forceOpen={forceOpenOutput} />;
}

function ItemViewImpl({
  item,
  actions,
  activeHitBlockIndex,
}: {
  item: ChatItem;
  actions: MessageAction[];
  activeHitBlockIndex: number | null;
}) {
  const toolbar = <MessageActions item={item} actions={actions} />;
  if (item.role === "system") {
    return (
      <div
        className={`system-item ${item.isError ? "item-error" : ""}`}
        data-testid="system-item"
        data-item-id={item.id}
      >
        {item.blocks.map((b, i) => (b.kind === "text" ? <span key={i}>{b.text}</span> : null))}
        {toolbar}
      </div>
    );
  }
  const streaming = item.role === "assistant" && !item.done;
  return (
    <div
      className={`item item-${item.role} ${item.isError ? "item-error" : ""}`}
      data-testid={`item-${item.role}`}
      data-item-id={item.id}
    >
      {toolbar}
      {/* Steer fire trace (spec 005 US5): rendered at fire time, dropped on
          replay. User items have no header (display:none), so the badge is a
          row of its own. */}
      {item.steer ? (
        <div className="steer-tag" data-testid="steer-tag">
          插话
        </div>
      ) : null}
      <div className="item-header">
        <span className="avatar" aria-hidden="true">π</span>
        <span className="who">Pi</span>
      </div>
      <div className="item-body">
        {displayBlocks(item).map((b, i) => (
          <BlockView key={i} block={b} forceOpenOutput={activeHitBlockIndex === i} itemId={item.id} blockIndex={i} />
        ))}
        {streaming && <span className="cursor" />}
      </div>
      {item.usage?.cost?.total ? <div className="item-cost">${item.usage.cost.total.toFixed(4)}</div> : null}
    </div>
  );
}

/**
 * 022 D5: every store change (stats, queue, language, streaming ticks) used to
 * repaint the whole transcript. The comparator only accepts a changed item
 * reference, a changed highlight block, or a changed action set — note
 * `actionsForItem()` allocates a new array each render, so the action ids are
 * compared by content.
 */
const ItemView = memo(
  ItemViewImpl,
  (a, b) =>
    a.item === b.item &&
    a.activeHitBlockIndex === b.activeHitBlockIndex &&
    sameActionIds(a.actions, b.actions),
);

/**
 * Presentation blocks (011 US4, T015): skill-expanded user messages show the
 * `/skill:<name>` marker + question, never the SKILL.md body. The store keeps
 * pi's raw text — search (006) and the HTML export operate on the store list,
 * so folding here cannot leak into them; block indexes stay 1:1.
 */
function displayBlocks(item: ChatItem): ContentBlock[] {
  if (item.role === "user") {
    return item.blocks.map((b) =>
      b.kind === "text" ? { ...b, text: displaySkillText(b.text) } : b,
    );
  }
  return item.blocks;
}

export default function MessageList() {
  const items = usePiStore((s) => s.items);
  const retryInfo = usePiStore((s) => s.retryInfo);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const editing = usePiStore((s) => s.editing);
  const search = usePiStore((s) => s.search);
  const pendingSwitch = usePiStore((s) => s.pendingSwitch);
  const { t } = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 022 D4: "follow new content?" as explicit state — see lib/pin.ts. */
  const pinRef = useRef<PinState>(initialPin());
  /** Set by an upward wheel/arrow gesture; consumed by the next scroll event. */
  const userUpRef = useRef(false);

  // The hit the search bar currently points at (spec 006 US2): its tool card
  // must auto-expand (T011) and its block gets the paint anchor.
  const activeHit = useMemo(() => {
    if (!search.open || !search.query.trim()) return null;
    const hits = hitsFromItems(items, search.query);
    return hits[search.index] ?? null;
  }, [search.open, search.query, search.index, items]);

  // "Last message" is asked per role, not "last item": a trailing system
  // notice must not hide the regenerate/edit buttons of the message above it.
  let lastUser = -1;
  let lastAssistant = -1;
  items.forEach((item, i) => {
    if (item.role === "user") lastUser = i;
    if (item.role === "assistant") lastAssistant = i;
  });
  // Fork needs a user message *above* the reply to branch at (007 FR-001);
  // an assistant item with no question before it gets no Fork button.
  const userAbove: boolean[] = [];
  let seenUser = false;
  items.forEach((item, i) => {
    userAbove[i] = seenUser;
    if (item.role === "user") seenUser = true;
  });
  // 023 D2: one round = one question + *all* of its pi replies (a tool-call
  // reply and the summary are two items). Fork belongs to the round's last
  // reply only — `fork` cuts at user entries, so every other position would
  // branch to the very same place while promising something else.
  // System notices deliberately do not close a round: a retry banner or a
  // compaction hint must not cost the round its Fork.
  const roundEnd: boolean[] = items.map(() => false);
  let pendingRoundEnd = -1;
  items.forEach((item, i) => {
    if (item.role === "user") {
      if (pendingRoundEnd >= 0) roundEnd[pendingRoundEnd] = true;
      pendingRoundEnd = -1;
    } else if (item.role === "assistant") {
      pendingRoundEnd = i;
    }
  });
  if (pendingRoundEnd >= 0) roundEnd[pendingRoundEnd] = true;
  const ctx = { sessionBusy: isStreaming, editing: editing != null };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinRef.current.pinned) return;
    el.scrollTop = el.scrollHeight;
    // Record where the programmatic scroll landed, or the next `onScroll`
    // would read it as an upward move.
    pinRef.current = { pinned: true, lastTop: el.scrollTop, lastHeight: el.scrollHeight };
  }, [items, retryInfo]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const userUp = userUpRef.current;
    userUpRef.current = false;
    pinRef.current = nextPin(pinRef.current, el.scrollTop, el.scrollHeight, el.clientHeight, userUp);
  };

  /**
   * 022 D7 / T411 — `scroll.frame`: how long the first frame after a wheel
   * event took. Only a *dropped* frame (>50ms) is logged, so a normal scroll
   * writes nothing to idea.log; the numbers that matter are the outliers.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // The gesture itself is the most reliable "the user wants to go up"
      // signal — geometry can be distorted by content-visibility re-measuring.
      if (event.deltaY < 0) userUpRef.current = true;
      const startedAt = performance.now();
      const before = el.scrollTop;
      requestAnimationFrame(() => {
        const spent = performance.now() - startedAt;
        if (spent > 50) perfMark("scroll.frame", startedAt, { dy: Math.round(el.scrollTop - before) });
      });
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="message-list" ref={scrollRef} onScroll={onScroll} data-testid="message-list">
      <div className="message-col">
        {/* 021 T307: a history switch empties `items` first — the empty state
            would read as "this session is blank", so a switching placeholder
            stands in until the transcript lands. A *new* session really is
            empty, so it keeps the empty state (US2). */}
        {items.length === 0 && pendingSwitch?.kind === "history" ? (
          <SwitchingPlaceholder startedAt={pendingSwitch.startedAt} />
        ) : null}
        {items.length === 0 && pendingSwitch?.kind !== "history" ? <EmptyState /> : null}
        {items.map((item, i) => (
          <ItemView
            key={item.id}
            item={item}
            activeHitBlockIndex={activeHit && activeHit.itemId === item.id ? activeHit.blockIndex : null}
            actions={actionsForItem(item, {
              ...ctx,
              isLastUser: i === lastUser,
              isLastAssistant: i === lastAssistant,
              hasPrecedingUser: userAbove[i] ?? false,
              isRoundEnd: roundEnd[i] ?? false,
            })}
          />
        ))}
        {retryInfo ? (
          <div className="system-item retry" data-testid="retry-banner">
            {t("chat.retryBanner", {
              attempt: retryInfo.attempt,
              max: retryInfo.maxAttempts,
              seconds: Math.round(retryInfo.delayMs / 1000),
              error: retryInfo.errorMessage,
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 021 T307/T308 — stands in for a transcript that is being fetched. The copy
 * softens after 10s (`session.switchingLong`) but nothing rolls back: a slow
 * pi is not a failed one.
 */
function SwitchingPlaceholder({ startedAt }: { startedAt: number }) {
  const { t } = useT();
  const [long, setLong] = useState(() => isSwitchLong(startedAt, Date.now()));

  useEffect(() => {
    const elapsed = Date.now() - startedAt;
    if (isSwitchLong(startedAt, Date.now())) {
      setLong(true);
      return;
    }
    const id = setTimeout(() => setLong(true), Math.max(0, SWITCH_LONG_MS - elapsed));
    return () => clearTimeout(id);
  }, [startedAt]);

  return (
    <div className="session-switching" data-testid="session-switching" role="status" aria-live="polite">
      <span className="session-switching-dot" aria-hidden="true" />
      <span>{long ? t("session.switchingLong") : t("session.switching")}</span>
    </div>
  );
}

function EmptyState() {
  const bridgeKind = usePiStore((s) => s.bridgeKind);
  const model = usePiStore((s) => s.model);
  const { t } = useT();
  return (
    <div className="empty-state" data-testid="empty-state">
      <div className="empty-logo">π</div>
      <div className="empty-title">Pi Agent</div>
      <div className="empty-sub">
        {model ? `${model.name ?? model.id} · ${model.provider}` : t("chat.empty.noModel")}{" "}
        {bridgeKind === "mock" ? `· ${t("chat.empty.mock")}` : ""}
      </div>
    </div>
  );
}
