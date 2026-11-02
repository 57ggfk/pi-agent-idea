import { useEffect, useMemo, useRef, useState } from "react";
import { usePiStore } from "../store/store";
import Icon from "./Icon";

const MAX_RENDERED = 200;

/**
 * Bottom-bar model chip + searchable popover.
 * Filter supports space-separated keywords: every keyword must appear in the
 * model's id/name/provider (case-insensitive), e.g. "openrouter free" or "kimi".
 */
export default function ModelPicker() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const models = usePiStore((s) => s.models);
  const model = usePiStore((s) => s.model);
  const setModel = usePiStore((s) => s.setModel);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const keywords = useMemo(
    () => query.toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  const matches = useMemo(() => {
    if (keywords.length === 0) return models;
    return models.filter((m) => {
      const haystack = `${m.provider} ${m.id} ${m.name ?? ""}`.toLowerCase();
      return keywords.every((k) => haystack.includes(k));
    });
  }, [models, keywords]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, matches.length, open]);

  const pick = (index: number) => {
    const m = matches[index];
    if (!m) return;
    void setModel(m.provider, m.id);
    setOpen(false);
  };

  const label = model ? model.name ?? model.id : "Select model…";

  return (
    <div className="model-picker">
      <button
        className="chip"
        data-testid="model-chip"
        onClick={() => setOpen((o) => !o)}
        title={model ? `${label} — ${model.provider}/${model.id}` : "Select model"}
        aria-label={model ? `Model: ${label}` : "Select model"}
      >
        <Icon name="sparkles" className="ic-sm chip-icon" />
        <span className="chip-label">{label}</span>
        <Icon name="chev-down" className="ic-sm chip-caret" />
      </button>

      {open ? (
        <div className="model-popover" data-testid="model-popover">
          <input
            ref={inputRef}
            className="select model-search"
            data-testid="model-search"
            placeholder="Filter models… (space = AND, e.g. openrouter free)"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((i) => Math.min(i + 1, Math.min(matches.length, MAX_RENDERED) - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(highlight);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
          <div className="model-list" ref={listRef}>
            {matches.length === 0 ? (
              <div className="panel-empty" data-testid="model-empty">
                No models match “{query}”.
              </div>
            ) : null}
            {matches.slice(0, MAX_RENDERED).map((m, i) => {
              const current = model && m.provider === model.provider && m.id === model.id;
              return (
                <div
                  key={`${m.provider}/${m.id}`}
                  className={`model-option ${i === highlight ? "model-option-active" : ""}`}
                  data-testid="model-option"
                  data-active={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(i);
                  }}
                >
                  <span className="model-option-check">{current ? "✓" : ""}</span>
                  <span className="model-option-main">
                    <span className="model-option-name">{m.name ?? m.id}</span>
                    <span className="model-option-sub">{m.id}</span>
                  </span>
                  <span className="model-option-provider">{m.provider}</span>
                </div>
              );
            })}
            {matches.length > MAX_RENDERED ? (
              <div className="panel-empty">…and {matches.length - MAX_RENDERED} more — refine the filter</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
