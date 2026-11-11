import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import Icon from "../Icon";
import { filterProviderOptions } from "../../lib/knownProviders";
import type { ProviderOption } from "../../lib/knownProviders";
import { ensureVisible } from "../../lib/modelGroups";

/** Dropdown sentinel shared with ProviderForm — the "custom provider" option. */
export const PROVIDER_CUSTOM = "__custom__";

/**
 * Searchable provider dropdown for the credential forms (013 US1): the 42
 * built-in pi providers are far too many for a native <select>.
 *
 * Interaction contract copied from ModelPicker (011 US1–US3, locked in
 * specs/011): space-separated keywords ANDed (case-insensitive, over name and
 * id), ↑↓/Enter/Esc keys, mousedown outside closes, opening once locates and
 * scrolls to the current selection (single rAF, never scrollIntoView). The
 * "custom provider (models.json)" entry is pinned at the bottom, never
 * filtered out. The popover reuses the `.model-*` style family sized to the
 * form field.
 */
export default function ProviderPicker({
  options,
  value,
  onChange,
  disabled = false,
  loading = false,
  testPrefix,
}: {
  options: readonly ProviderOption[];
  /** Selected provider id, the CUSTOM sentinel, or "" (nothing yet). */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  loading?: boolean;
  testPrefix: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Open-locate runs once per open, like ModelPicker. */
  const locatedRef = useRef(false);

  const filtered = useMemo(() => filterProviderOptions(options, query), [options, query]);
  /** Keyboard-nav order: filtered options, then the pinned custom entry. */
  const flat = useMemo<(ProviderOption | "custom")[]>(() => [...filtered, "custom"], [filtered]);

  useEffect(() => {
    if (!open) return;
    locatedRef.current = false;
    setQuery("");
    setHighlight(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  /**
   * 022 D1/D3: hovering must not scroll and must not re-render. The pointer
   * position is a ref; only keyboard navigation moves `highlight`, and only
   * keyboard navigation is allowed to call `ensureVisible`.
   */
  const hoverIndexRef = useRef<number | null>(null);
  const scrollOnChangeRef = useRef(false);

  // Locate the current selection once per open and scroll it into view only
  // when out of sight (same single-rAF guard as ModelPicker).
  useEffect(() => {
    if (!open || locatedRef.current || flat.length === 0) return;
    locatedRef.current = true;
    const raf = requestAnimationFrame(() => {
      const idx = flat.findIndex((e) => (e === "custom" ? value === PROVIDER_CUSTOM : e.id === value));
      scrollOnChangeRef.current = true;
      setHighlight(idx >= 0 ? idx : 0);
      const list = listRef.current;
      const target = idx >= 0 ? idx : 0;
      if (list) {
        const el = list.querySelectorAll("[data-provider-index]")[target];
        if (el) ensureVisible(list, el as HTMLElement);
      }
    });
    return () => cancelAnimationFrame(raf);
    // flat/value captured at effect time; locatedRef keeps it a single pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options]);

  useEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    // Hover never sets this flag, so the wheel owns the scroll position.
    if (!scrollOnChangeRef.current) return;
    scrollOnChangeRef.current = false;
    const el = list.querySelectorAll("[data-provider-index]")[highlight];
    if (el) ensureVisible(list, el as HTMLElement);
  }, [highlight, open]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onDocKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onDocKeyDown);
    };
  }, [open]);

  const pick = (index: number) => {
    const entry = flat[index];
    if (entry === undefined) return;
    onChange(entry === "custom" ? PROVIDER_CUSTOM : entry.id);
    setOpen(false);
  };

  const selectedName = (): string => {
    if (value === PROVIDER_CUSTOM) return t("provider.pickCustom");
    const opt = options.find((o) => o.id === value);
    if (opt) return opt.name;
    if (loading) return t("common.loading");
    return value || t("provider.pickPlaceholder");
  };

  return (
    <div className="provider-picker" ref={rootRef}>
      <button
        type="button"
        className="setup-input provider-picker-trigger"
        data-testid={`${testPrefix}-pick`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`provider-picker-value ${value === "" && !loading ? "provider-picker-placeholder" : ""}`}>
          {selectedName()}
        </span>
        <Icon name="chev-down" className="ic-sm provider-picker-caret" />
      </button>

      {open ? (
        <div className="model-popover provider-popover" data-testid={`${testPrefix}-popover`}>
          <input
            ref={inputRef}
            className="select model-search"
            data-testid={`${testPrefix}-search`}
            placeholder={t("provider.searchPlaceholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                scrollOnChangeRef.current = true;
                setHighlight((i) => Math.min(i + 1, flat.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                scrollOnChangeRef.current = true;
                setHighlight((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                // Enter still takes the row under the mouse when there is one
                // — it just no longer costs a render to know where that is.
                pick(hoverIndexRef.current ?? highlight);
              }
            }}
          />
          <div
            className="model-list"
            role="listbox"
            ref={listRef}
            onMouseLeave={() => {
              hoverIndexRef.current = null;
            }}
          >
            {filtered.length === 0 ? (
              <div className="panel-empty" data-testid={`${testPrefix}-no-match`}>
                {t("provider.noMatch", { query })}
              </div>
            ) : null}
            {filtered.map((o, index) => {
              const active = index === highlight;
              const current = o.id === value;
              return (
                <div
                  key={o.id}
                  className={`model-option ${active ? "model-option-active" : ""}`}
                  role="option"
                  aria-selected={current}
                  data-testid={`${testPrefix}-option`}
                  data-provider-index={index}
                  data-value={o.id}
                  data-active={active}
                  onMouseEnter={() => {
                    hoverIndexRef.current = index;
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(index);
                  }}
                >
                  <span className="model-option-check">{current ? "✓" : ""}</span>
                  <span className="model-option-main">
                    <span className="model-option-name">{o.name}</span>
                    <span className="model-option-sub">{o.id}</span>
                  </span>
                  {o.credType ? (
                    <span className="model-option-provider">
                      {o.credType === "oauth" ? t("auth.credTypeOauth") : t("auth.credTypeApiKey")}
                    </span>
                  ) : null}
                </div>
              );
            })}
            {/* Pinned, never filtered: custom providers are defined in
                models.json and are absent from the bundled registry. */}
            {(() => {
              const index = flat.length - 1;
              const active = index === highlight;
              const current = value === PROVIDER_CUSTOM;
              return (
                <div
                  className={`model-option provider-option-custom ${active ? "model-option-active" : ""}`}
                  role="option"
                  aria-selected={current}
                  data-testid={`${testPrefix}-custom`}
                  data-provider-index={index}
                  data-value={PROVIDER_CUSTOM}
                  data-active={active}
                  onMouseEnter={() => {
                    hoverIndexRef.current = index;
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(index);
                  }}
                >
                  <span className="model-option-check">{current ? "✓" : ""}</span>
                  <span className="model-option-main">
                    <span className="model-option-name">{t("provider.pickCustom")}</span>
                    <span className="model-option-sub">models.json</span>
                  </span>
                </div>
              );
            })()}
          </div>
        </div>
      ) : null}
    </div>
  );
}
