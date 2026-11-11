import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePiStore } from "../store/store";
import { MODELS_TTL_MS, needsRefresh } from "../store/sources";
import { useT } from "../i18n/useT";
import { buildPickerData, ensureVisible, type PickerModelData } from "../lib/modelGroups";
import { bumpHoverRender } from "../lib/perf";
import { tip } from "./Tooltip";
import Icon from "./Icon";

/**
 * Bottom-bar model chip + searchable popover (011 US1–US3, 018 US5).
 * Filter supports space-separated keywords: every keyword must appear in the
 * model's id/name/provider (case-insensitive), e.g. "openrouter free" or "kimi".
 *
 * Behavior locked in specs/011-0.5.4-defects:
 * - opening locates and highlights the current model (single rAF layout read,
 *   scroll only when the entry is not already visible — never scrollIntoView);
 * - entries are grouped by provider with the current group pinned first and
 *   rendered under a hard 200-entry cap (no virtual list);
 * - a mousedown outside the picker root (chip included) closes it.
 *
 * Spec 018 US5: provider groups collapse. Every index the picker reasons
 * about (highlight, keyboard, Enter, locate, DOM rows) lives in the VISIBLE
 * entry sequence — a collapsed group's entries leave that sequence entirely.
 * Opening auto-expands the current model's group so the locate target is
 * visible; the collapsed set survives restarts in localStorage (degrading to
 * in-memory when denied).
 *
 * Spec 020: at most 50 provider groups and at most `groupCap(n)` entries per
 * group (see lib/modelGroups). Search results keep the grouping and are
 * foldable too — the fold is a separate, transient set that starts empty on
 * each search so "matched but collapsed away" can't happen (US3).
 */

const COLLAPSED_STORAGE_KEY = "pi-agent.model-collapsed";

/** Reads the persisted collapsed-provider set; storage failures stay silent. */
function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? new Set(list.filter((v): v is string => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: Set<string>) {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // Private mode / denied storage — the in-memory state still works.
  }
}

interface ModelOptionProps {
  modelKey: string;
  id: string;
  name: string;
  provider: string;
  current: boolean;
  /** Keyboard current item — the only thing `data-active` means since 022. */
  active: boolean;
  index: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}

/**
 * One row (022 D2). Props are primitives plus two stable callbacks, so a wheel
 * step — which now only writes a ref — re-renders nothing. `bumpHoverRender`
 * is the counter behind the `hover.render` measurement.
 */
const ModelOption = memo(function ModelOption({
  modelKey,
  id,
  name,
  provider,
  current,
  active,
  index,
  onPick,
  onHover,
}: ModelOptionProps) {
  bumpHoverRender();
  return (
    <div
      className={`model-option ${active ? "model-option-active" : ""}`}
      data-testid="model-option"
      data-model-key={modelKey}
      data-active={active}
      onMouseEnter={() => onHover(index)}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick(index);
      }}
    >
      <span className="model-option-check">{current ? "✓" : ""}</span>
      <span className="model-option-main">
        <span className="model-option-name">{name}</span>
        <span className="model-option-sub">{id}</span>
      </span>
      {provider !== "" ? <span className="model-option-provider">{provider}</span> : null}
    </div>
  );
});

export default function ModelPicker() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  /** 020 D6: fold state while a search is active — transient, starts empty
   *  (everything matched is visible), never written to localStorage. */
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(() => new Set());
  const models = usePiStore((s) => s.models);
  const modelsSource = usePiStore((s) => s.sources.models);
  const reloadModels = usePiStore((s) => s.reloadModels);
  const model = usePiStore((s) => s.model);
  const setModel = usePiStore((s) => s.setModel);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Open-locate must run once per open, even if `models` lands late. */
  const locatedRef = useRef(false);
  /**
   * 022 D1/D3: the row under the pointer is a ref, not state. Writing state on
   * `mouseenter` re-rendered the whole list on every wheel notch (and then
   * forced a layout in `ensureVisible`) — the wheel queue was the "停一下才动"
   * the user reported. Only keyboard navigation moves `highlight`.
   */
  const hoverIndexRef = useRef<number | null>(null);
  const scrollOnChangeRef = useRef(false);

  const keywords = useMemo(
    () => query.toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );
  const searching = keywords.length > 0;
  /** The fold set in force right now: transient during a search (020 D6). */
  const effectiveCollapsed = searching ? searchCollapsed : collapsed;

  const data = useMemo<PickerModelData>(
    () => buildPickerData(models, model ?? null, keywords, { collapsed: effectiveCollapsed }),
    [models, model, keywords, effectiveCollapsed],
  );

  const toggleCollapsed = (provider: string) => {
    const write = (prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    };
    if (searching) {
      // Transient: folding while searching never touches the stored preference.
      setSearchCollapsed(write);
    } else {
      setCollapsed((prev) => {
        const next = write(prev);
        saveCollapsed(next);
        return next;
      });
    }
    setHighlight(0);
  };

  // 020 D6: a fresh search starts fully expanded; clearing it restores the
  // stored preference untouched.
  useEffect(() => {
    setSearchCollapsed(new Set());
  }, [searching]);

  useEffect(() => {
    if (open) {
      locatedRef.current = false;
      setQuery("");
      setHighlight(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  /**
   * Spec 016: credentials changed outside the plugin (terminal `/login`, a
   * hand-edited models.json) never pass through the auth panel, so the picker
   * re-reads the catalog on open once the data is stale. Not awaited — the
   * popover renders from whatever is already there and updates when it lands.
   */
  useEffect(() => {
    if (!open) return;
    if (needsRefresh(modelsSource, Date.now(), MODELS_TTL_MS)) void reloadModels();
  }, [open, modelsSource, reloadModels]);

  // US1: locate the current model once per open — highlight it and scroll only
  // if it is out of view. `models` is a dependency so a list that arrives late
  // (async load) still gets located; the ref guard keeps it a single pass.
  // 018 US5: a collapsed current group is expanded first, and the effect
  // re-runs after that state lands to do the actual locating.
  useEffect(() => {
    if (!open || locatedRef.current || data.flat.length === 0) return;
    if (model) {
      const group = data.groups.find((g) =>
        g.models.some((mo) => mo.provider === model.provider && mo.id === model.id),
      );
      if (group && effectiveCollapsed.has(group.provider)) {
        toggleCollapsed(group.provider);
        return;
      }
    }
    locatedRef.current = true;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      const idx = data.activeFlatIndex;
      scrollOnChangeRef.current = true;
      setHighlight(idx ?? 0);
      const list = listRef.current;
      if (list && idx != null) {
        const el = list.querySelectorAll("[data-model-key]")[idx];
        if (el) ensureVisible(list, el as HTMLElement);
      }
    });
    return () => cancelAnimationFrame(raf);
    // `data` is captured at effect time; the locatedRef guard makes re-runs no-ops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, models, data, effectiveCollapsed]);

  // US1: keyboard navigation scrolls only when the highlighted entry leaves
  // the view — and only *because* of keyboard navigation (022 D3).
  useEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    if (!scrollOnChangeRef.current) return;
    scrollOnChangeRef.current = false;
    const el = list.querySelectorAll("[data-model-key]")[highlight];
    if (el) ensureVisible(list, el as HTMLElement);
  }, [highlight, open]);

  // Collapsing under the highlight must not leave a dangling index.
  useEffect(() => {
    setHighlight((i) => Math.min(i, Math.max(0, data.visibleFlat.length - 1)));
  }, [data.visibleFlat.length]);

  // US3: mousedown anywhere outside the picker root closes it. The root wraps
  // the chip, so a chip click toggles (mousedown inside → click toggles off).
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

  // `data` in a ref keeps `pick` (and therefore every row's `onPick`) stable —
  // a new callback per render would defeat the row memo below (D2).
  const dataRef = useRef(data);
  dataRef.current = data;
  const pick = useCallback(
    (index: number) => {
      const entry = dataRef.current.visibleFlat[index];
      if (!entry) return;
      void setModel(entry.model.provider, entry.model.id);
      setOpen(false);
    },
    [setModel],
  );

  /** Stable across renders: hovering only records a number (022 D1). */
  const onHover = useCallback((index: number) => {
    hoverIndexRef.current = index;
  }, []);

  const { t } = useT();
  const label = model ? model.name ?? model.id : t("model.select");
  const currentKey = model ? `${model.provider}/${model.id}` : null;

  // Visible index of every rendered entry — the render maps groups, but the
  // highlight/pick space is the visibleFlat sequence.
  const visibleIndexOf = useMemo(() => {
    const map = new Map<string, number>();
    data.visibleFlat.forEach((e, i) => map.set(`${e.model.provider}/${e.model.id}`, i));
    return map;
  }, [data.visibleFlat]);

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        className="chip"
        data-testid="model-chip"
        onClick={() => setOpen((o) => !o)}
        {...tip(model ? t("model.tip", { name: label, provider: model.provider, id: model.id }) : t("model.selectTitle"))}
        aria-label={model ? t("model.aria", { name: label }) : t("model.selectTitle")}
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
            placeholder={t("model.filterPlaceholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                scrollOnChangeRef.current = true;
                setHighlight((i) => Math.min(i + 1, data.visibleFlat.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                scrollOnChangeRef.current = true;
                setHighlight((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                // Enter keeps the "pick what the mouse points at" feel without
                // paying a render for hover (US1 ③).
                pick(hoverIndexRef.current ?? highlight);
              }
            }}
          />
          <div
            className="model-list"
            ref={listRef}
            onMouseLeave={() => {
              hoverIndexRef.current = null;
            }}
          >
            {data.visibleFlat.length === 0 ? (
              <div className="panel-empty" data-testid="model-empty">
                {t("model.noMatch", { query })}
              </div>
            ) : null}
            {data.groups.map((group) => {
              const isCollapsed = effectiveCollapsed.has(group.provider);
              return (
                <Fragment key={group.provider || "__other__"}>
                  <button
                    type="button"
                    className="model-group-title"
                    data-testid="model-group"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleCollapsed(group.provider)}
                  >
                    <Icon name="chev-right" className={`ic-sm model-group-caret${isCollapsed ? "" : " model-group-caret-open"}`} />
                    <span className="model-group-name">
                      {group.provider === "" ? t("model.group.other") : group.provider}
                    </span>
                    <span className="model-group-count" data-testid="model-group-count">
                      {group.hidden > 0
                        ? t("model.group.count", { shown: group.shown, total: group.total })
                        : String(group.total)}
                    </span>
                  </button>
                  {!isCollapsed ? (
                    <>
                      {group.models.map((entry) => {
                        const key = `${entry.provider}/${entry.id}`;
                        const vi = visibleIndexOf.get(key) ?? 0;
                        return (
                          <ModelOption
                            key={key}
                            modelKey={key}
                            id={entry.id}
                            name={entry.name ?? entry.id}
                            provider={entry.provider}
                            current={currentKey !== null && key === currentKey}
                            active={vi === highlight}
                            index={vi}
                            onPick={pick}
                            onHover={onHover}
                          />
                        );
                      })}
                      {group.hidden > 0 ? (
                        <div className="panel-empty model-group-more" data-testid="model-group-more">
                          {t("model.group.more", { count: group.hidden })}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </Fragment>
              );
            })}
            {data.hiddenProviders > 0 ? (
              <div className="panel-empty" data-testid="model-providers-more">
                {t("model.providers.more", { count: data.hiddenProviders })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
