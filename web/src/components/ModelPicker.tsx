import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { usePiStore } from "../store/store";
import { useT } from "../i18n/useT";
import { buildPickerData, ensureVisible, type PickerModelData } from "../lib/modelGroups";
import { tip } from "./Tooltip";
import Icon from "./Icon";

/**
 * Bottom-bar model chip + searchable popover (011 US1–US3).
 * Filter supports space-separated keywords: every keyword must appear in the
 * model's id/name/provider (case-insensitive), e.g. "openrouter free" or "kimi".
 *
 * Behavior locked in specs/011-0.5.4-defects:
 * - opening locates and highlights the current model (single rAF layout read,
 *   scroll only when the entry is not already visible — never scrollIntoView);
 * - entries are grouped by provider with the current group pinned first and
 *   rendered under a hard 200-entry cap (no virtual list);
 * - a mousedown outside the picker root (chip included) closes it.
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
  const rootRef = useRef<HTMLDivElement>(null);
  /** Open-locate must run once per open, even if `models` lands late. */
  const locatedRef = useRef(false);

  const keywords = useMemo(
    () => query.toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  const data = useMemo<PickerModelData>(
    () => buildPickerData(models, model ?? null, keywords),
    [models, model, keywords],
  );

  useEffect(() => {
    if (open) {
      locatedRef.current = false;
      setQuery("");
      setHighlight(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // US1: locate the current model once per open — highlight it and scroll only
  // if it is out of view. `models` is a dependency so a list that arrives late
  // (async load) still gets located; the ref guard keeps it a single pass.
  useEffect(() => {
    if (!open || locatedRef.current || data.flat.length === 0) return;
    locatedRef.current = true;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      const idx = data.activeFlatIndex;
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
  }, [open, models]);

  // US1: navigation scrolls only when the highlighted entry leaves the view.
  useEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    const el = list.querySelectorAll("[data-model-key]")[highlight];
    if (el) ensureVisible(list, el as HTMLElement);
  }, [highlight, open]);

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

  const pick = (index: number) => {
    const entry = data.flat[index];
    if (!entry) return;
    void setModel(entry.model.provider, entry.model.id);
    setOpen(false);
  };

  const { t } = useT();
  const label = model ? model.name ?? model.id : t("model.select");
  const currentKey = model ? `${model.provider}/${model.id}` : null;

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
                setHighlight((i) => Math.min(i + 1, data.flat.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(highlight);
              }
            }}
          />
          <div className="model-list" ref={listRef}>
            {data.flat.length === 0 ? (
              <div className="panel-empty" data-testid="model-empty">
                {t("model.noMatch", { query })}
              </div>
            ) : null}
            {data.groups.map((group, groupIndex) => (
              <Fragment key={group.provider || "__other__"}>
                <div className="model-group-title" data-testid="model-group">
                  <span className="model-group-name">
                    {group.provider === "" ? t("model.group.other") : group.provider}
                  </span>
                  <span className="model-group-count">{group.models.length}</span>
                </div>
                {data.flat
                  .filter((entry) => entry.groupIndex === groupIndex)
                  .map((entry) => {
                    const active = entry.flatIndex === highlight;
                    const current =
                      currentKey !== null &&
                      `${entry.model.provider}/${entry.model.id}` === currentKey;
                    return (
                      <div
                        key={`${entry.model.provider}/${entry.model.id}`}
                        className={`model-option ${active ? "model-option-active" : ""}`}
                        data-testid="model-option"
                        data-model-key={`${entry.model.provider}/${entry.model.id}`}
                        data-active={active}
                        onMouseEnter={() => setHighlight(entry.flatIndex)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          pick(entry.flatIndex);
                        }}
                      >
                        <span className="model-option-check">{current ? "✓" : ""}</span>
                        <span className="model-option-main">
                          <span className="model-option-name">{entry.model.name ?? entry.model.id}</span>
                          <span className="model-option-sub">{entry.model.id}</span>
                        </span>
                        {entry.model.provider !== "" ? (
                          <span className="model-option-provider">{entry.model.provider}</span>
                        ) : null}
                      </div>
                    );
                  })}
              </Fragment>
            ))}
            {data.hidden > 0 ? (
              <div className="panel-empty">{t("model.more", { count: data.hidden })}</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
