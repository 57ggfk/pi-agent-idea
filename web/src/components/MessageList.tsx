import { useEffect, useRef, useState } from "react";
import { usePiStore } from "../store/store";
import type { ChatItem, ContentBlock } from "../store/types";
import Markdown from "./Markdown";
import ToolCard from "./ToolCard";
import Icon from "./Icon";

function BlockView({ block }: { block: ContentBlock }) {
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
  return <ToolCard block={block} />;
}

function ItemView({ item }: { item: ChatItem }) {
  if (item.role === "system") {
    return (
      <div className={`system-item ${item.isError ? "item-error" : ""}`} data-testid="system-item">
        {item.blocks.map((b, i) => (b.kind === "text" ? <span key={i}>{b.text}</span> : null))}
      </div>
    );
  }
  const streaming = item.role === "assistant" && !item.done;
  return (
    <div className={`item item-${item.role} ${item.isError ? "item-error" : ""}`} data-testid={`item-${item.role}`}>
      <div className="item-header">
        <span className="avatar" aria-hidden="true">π</span>
        <span className="who">Pi</span>
      </div>
      <div className="item-body">
        {item.blocks.map((b, i) => (
          <BlockView key={i} block={b} />
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

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
        {items.map((item) => (
          <ItemView key={item.id} item={item} />
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
