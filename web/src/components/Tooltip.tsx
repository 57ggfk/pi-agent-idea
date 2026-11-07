import { useEffect, useRef } from "react";
import { placeTooltip } from "../lib/tooltip";

/**
 * App-wide tooltip (012 US2, plan D5): one delegated listener pair watches
 * `pointerover`/`focusin` for elements carrying a `data-tip` attribute, so
 * wiring a button is exactly one attribute — no wrappers, no portals per
 * component, no layout drift. hover and focus both trigger, Esc / blur /
 * click / scroll dismiss, and the bubble never swallows pointer events.
 *
 * Replaces the native `title` attribute: JCEF does not guarantee native
 * tooltips, and a styled in-app layer can match the theme and the i18n text.
 */

const SHOW_DELAY_MS = 350;

/** Spread onto any element that should show a tooltip. */
export function tip(label: string | undefined): { "data-tip"?: string } {
  return label ? { "data-tip": label } : {};
}

export default function TooltipHost() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let target: Element | null = null;
    let showTimer = 0;
    // A pointerdown hides the bubble, but the click also FOCUSES the button —
    // without a suppress window the focusin would instantly re-show it.
    let suppressed: Element | null = null;
    let suppressedAt = 0;

    const hide = () => {
      window.clearTimeout(showTimer);
      showTimer = 0;
      target = null;
      el.hidden = true;
    };

    const showFor = (next: Element) => {
      if (next === suppressed && Date.now() - suppressedAt < 800) return;
      if (next !== target) {
        window.clearTimeout(showTimer);
        target = next;
        showTimer = window.setTimeout(() => {
          const label = target?.getAttribute("data-tip");
          if (!label || !target?.isConnected) return;
          el.textContent = label;
          el.hidden = false;
          const anchor = target.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          // Measure the bubble after the text lands.
          const rect = el.getBoundingClientRect();
          const p = placeTooltip(
            { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
            { width: rect.width || 120, height: rect.height || 24 },
            { width: vw, height: vh },
          );
          el.style.top = `${p.top}px`;
          el.style.left = `${p.left}px`;
        }, SHOW_DELAY_MS);
      }
    };

    const isTip = (e: Event) => {
      const el2 = e.target as Element | null;
      return el2?.closest?.("[data-tip]") ?? null;
    };

    const onOver = (e: PointerEvent) => {
      const next = isTip(e);
      if (next) showFor(next);
      else if (target) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const next = isTip(e);
      if (next) showFor(next);
      else if (target) hide();
    };
    const onOut = (e: PointerEvent) => {
      // Leaving the tipped element (or its subtree) hides; moving within it
      // fires pointerover again before this matters.
      if (!target) return;
      const related = e.relatedTarget as Element | null;
      if (!related || !target.contains(related)) hide();
    };
    const onFocusOut = () => {
      if (target) hide();
    };
    const onDown = () => {
      if (target) {
        suppressed = target;
        suppressedAt = Date.now();
        hide();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && target) hide();
    };
    const onScroll = () => {
      // A stale anchor is worse than no tooltip.
      if (target) hide();
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.clearTimeout(showTimer);
    };
  }, []);

  return (
    <div className="tooltip" role="tooltip" ref={ref} hidden style={{ pointerEvents: "none" }} />
  );
}
