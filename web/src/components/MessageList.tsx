import { useEffect, useMemo, useRef, useState } from "react";
import { usePiStore } from "../store/store";
import { actionsForItem, type ChatItem, type ContentBlock, type MessageAction } from "../store/types";
import { hitsFromItems } from "../lib/search";
import Markdown from "./Markdown";
import MessageActions from "./MessageActions";
import ToolCard from "./ToolCard";
import Icon from "./Icon";

function BlockView({ block, forceOpenOutput }: { block: ContentBlock; forceOpenOutput?: boolean }) {
  const [open, setOpen] = useState(false);
  if (block.kind === "text") {
    if (!block.text) return null;
    return <Markdown text={block.text} />;
  }
  if (block.kind === "image") {
    if (!block.data) return null;
    const src = block.data.startsWith("data:") ? block.data : `data:${block.mimeType};base64,${block.data}`;
    return <img className="msg-image" src={src} alt="attached image" data-testid="msg-image" />;
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

function ItemView({
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
        {item.blocks.map((b, i) => (
          <BlockView key={i} block={b} forceOpenOutput={activeHitBlockIndex === i} />
        ))}
        {streaming && <span className="cursor" />}
      </div>
      {item.usage?.cost?.total ? <div className="item-cost">${item.usage.cost.total.toFixed(4)}</div> : null}
    </div>
  );
}

export default function MessageList() {
  const items = usePiStore((s) => s.items);
  const retryInfo = usePiStore((s) => s.retryInfo);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const editing = usePiStore((s) => s.editing);
  const search = usePiStore((s) => s.search);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

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
  const ctx = { sessionBusy: isStreaming, editing: editing != null };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items, retryInfo]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <div className="message-list" ref={scrollRef} onScroll={onScroll} data-testid="message-list">
      <div className="message-col">
        {items.length === 0 ? <EmptyState /> : null}
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
            })}
          />
        ))}
        {retryInfo ? (
          <div className="system-item retry" data-testid="retry-banner">
            Retrying ({retryInfo.attempt}/{retryInfo.maxAttempts}) in{" "}
            {Math.round(retryInfo.delayMs / 1000)}s — {retryInfo.errorMessage}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EmptyState() {
  const bridgeKind = usePiStore((s) => s.bridgeKind);
  const model = usePiStore((s) => s.model);
  return (
    <div className="empty-state" data-testid="empty-state">
      <div className="empty-logo">π</div>
      <div className="empty-title">Pi Agent</div>
      <div className="empty-sub">
        {model ? `${model.name ?? model.id} · ${model.provider}` : "No model selected"}{" "}
        {bridgeKind === "mock" ? "· mock mode" : ""}
      </div>
    </div>
  );
}
