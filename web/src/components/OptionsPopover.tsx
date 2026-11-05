import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThemePreference } from "../bridge/types";
import { usePiStore } from "../store/store";
import { LANGUAGES } from "../i18n/languages";
import { useT } from "../i18n/useT";
import Icon from "./Icon";

const THEME_OPTIONS: Array<{ value: ThemePreference; labelKey: "theme.system" | "theme.light" | "theme.dark"; hintKey: "theme.systemHint" | "theme.lightHint" | "theme.darkHint" }> = [
  { value: "system", labelKey: "theme.system", hintKey: "theme.systemHint" },
  { value: "light", labelKey: "theme.light", hintKey: "theme.lightHint" },
  { value: "dark", labelKey: "theme.dark", hintKey: "theme.darkHint" },
];

interface RowProps {
  label: string;
  testId: string;
  checked: boolean;
  onToggle(): void;
  hint?: string;
}

function OptionRow({ label, testId, checked, onToggle, hint }: RowProps) {
  // Plain div, not a <label>: label-wrapped switches re-dispatch clicks and
  // confuse both pointer automation and double-toggle handling.
  return (
    <div className="options-row" data-testid={testId} title={hint}>
      <span className="options-label">{label}</span>
      <button
        type="button"
        className={`switch ${checked ? "switch-on" : ""}`}
        data-testid={`${testId}-toggle`}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onToggle()}
      >
        <span className="knob" />
      </button>
    </div>
  );
}

/**
 * Bottom-bar options menu (opens upward, mirroring the thinking picker):
 * pi-managed toggles plus the tool-approval mode of the bundled extension.
 */
export default function OptionsPopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useT();
  const approvalMode = usePiStore((s) => s.approvalMode);
  const setApprovalMode = usePiStore((s) => s.setApprovalMode);
  const autoCompaction = usePiStore((s) => s.autoCompaction);
  const setAutoCompaction = usePiStore((s) => s.setAutoCompaction);
  const autoRetry = usePiStore((s) => s.autoRetry);
  const setAutoRetry = usePiStore((s) => s.setAutoRetry);
  const themePreference = usePiStore((s) => s.themePreference);
  const setThemePreference = usePiStore((s) => s.setThemePreference);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  /**
   * Places the menu inside the tool window. A fixed 280px popover opening from a
   * button that sits mid-row used to leave the menu hanging over the window
   * edge: the tool window clips it, so the switches at the row's right end were
   * literally invisible. Measure instead of guessing left/right, and cap the
   * height so the menu never runs past the top of the window either.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const menu = menuRef.current;
      const root = rootRef.current;
      if (!menu || !root) return;
      const anchor = root.getBoundingClientRect();
      // `.app` is the tool window (it also carries the container query), so it
      // is the box the menu has to stay inside of.
      const host = document.querySelector(".app");
      const bounds = (host ?? document.documentElement).getBoundingClientRect();
      const margin = 8;
      const width = Math.min(menu.offsetWidth || 300, Math.max(160, bounds.width - margin * 2));
      // Default: right edge flush with the trigger. Then clamp into the window;
      // `left` is relative to the (relatively positioned) options-picker.
      const preferred = anchor.right - width - anchor.left;
      const minLeft = bounds.left + margin - anchor.left;
      const maxLeft = bounds.right - margin - width - anchor.left;
      const left = Math.min(Math.max(preferred, minLeft), Math.max(minLeft, maxLeft));
      menu.style.left = `${Math.round(left)}px`;
      menu.style.right = "auto";
      menu.style.width = `${Math.round(width)}px`;
      // The trigger lives in the composer's control row, inside the input box:
      // anchoring to it would park the menu on top of the textarea. Anchor to
      // the composer instead, so the popover floats clear of the whole box.
      const inner = document.querySelector(".composer-inner");
      const innerTop = inner ? inner.getBoundingClientRect().top : anchor.top;
      const topEdge = Math.min(innerTop, anchor.top) - 6;
      menu.style.bottom = `${Math.round(anchor.bottom - topEdge)}px`;
      const headroom = topEdge - bounds.top - margin;
      menu.style.maxHeight = `${Math.max(160, Math.round(headroom))}px`;
    };
    place();
    window.addEventListener("resize", place);
    // Label changes (a longer model name) resize the trigger row, not the
    // window; re-place on any size change of the composer.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (rootRef.current) ro?.observe(rootRef.current);
    return () => {
      window.removeEventListener("resize", place);
      ro?.disconnect();
    };
  }, [open]);

  return (
    <div className="options-picker" ref={rootRef}>
      <button
        type="button"
        className="btn btn-ghost btn-tool"
        data-testid="options-btn"
        aria-label={t("composer.options")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        title={t("composer.options")}
      >
        <Icon name="settings" className="ic-sm" />
        <span className="btn-lbl">{t("composer.optionsLabel")}</span>
      </button>
      {open ? (
        <div className="options-menu" data-testid="options-menu" ref={menuRef}>
          <div className="options-row options-row-stack">
            <span className="options-label">{t("theme.label")}</span>
            <div className="segmented" role="radiogroup" aria-label={t("theme.label")}>
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={themePreference === option.value}
                  className={`segment ${themePreference === option.value ? "segment-active" : ""}`}
                  data-testid={`opt-theme-${option.value}`}
                  title={t(option.hintKey)}
                  onClick={() => setThemePreference(option.value)}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
            <span className="options-hint">{t("theme.hint")}</span>
          </div>
          <OptionRow
            label={t("options.autoCompact")}
            testId="opt-auto-compaction"
            checked={autoCompaction ?? true}
            hint={t("options.autoCompactHint")}
            onToggle={() => void setAutoCompaction(!(autoCompaction ?? true))}
          />
          <OptionRow
            label={t("options.autoRetry")}
            testId="opt-auto-retry"
            checked={autoRetry ?? true}
            hint={t("options.autoRetryHint")}
            onToggle={() => void setAutoRetry(!(autoRetry ?? true))}
          />
          <OptionRow
            label={t("options.approve")}
            testId="opt-approval"
            checked={approvalMode === "yolo"}
            hint={approvalMode === "yolo" ? t("options.approveOn") : t("options.approveOff")}
            onToggle={() => void setApprovalMode(approvalMode === "yolo" ? "ask" : "yolo")}
          />
          <LanguageRow />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Language picker (spec 008 US2 / D4): with at most 3 options it renders the
 * same `.segmented` control as the Theme row; more options degrade to a
 * native <select>. Both shapes share the LANGUAGES registry — adding a
 * language never touches this component (FR-016, locked by i18n tests).
 * Option text is each language's own name, never translated.
 */
function LanguageRow() {
  const { t } = useT();
  const languagePref = usePiStore((s) => s.languagePref);
  const setLanguagePreference = usePiStore((s) => s.setLanguagePreference);
  const options = [
    { value: "system", label: t("language.followIde") },
    ...LANGUAGES.map((l) => ({ value: l.code, label: l.nativeLabel })),
  ];
  const useSelect = options.length > 3;

  return (
    <div className="options-row options-row-stack" data-testid="opt-language" title={t("language.hint")}>
      <span className="options-label">{t("language.label")}</span>
      {useSelect ? (
        <select
          className="segmented language-select"
          aria-label={t("language.selector")}
          data-testid="opt-language-select"
          value={languagePref}
          onChange={(e) => void setLanguagePreference(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="segmented" role="radiogroup" aria-label={t("language.selector")}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={languagePref === o.value}
              className={`segment ${languagePref === o.value ? "segment-active" : ""}`}
              data-testid={`opt-language-${o.value}`}
              onClick={() => void setLanguagePreference(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      <span className="options-hint">{t("language.hint")}</span>
    </div>
  );
}
