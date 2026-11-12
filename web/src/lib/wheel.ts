/**
 * Wheel sensitivity.
 *
 * The report: "scrolling feels slower than the IDE editor right above it".
 *
 * Measured before changing anything (`web/probe-wheel-scale.mjs`, real notches
 * via WM_MOUSEWHEEL into WebStorm's JCEF panel): one detent arrives as
 * deltaY=100 and moves the transcript exactly 100px — *more* than the editor's
 * three lines (58px), so the distance is not the complaint. What is: those
 * 100px are spent on a ~190ms animation (25ms→6px, 58ms→24px, 108ms→66px),
 * so a second notch queues behind the first and the view falls behind the
 * hand. The editor moved instantly, hence "the webview is slower".
 *
 * Neither the system wheel setting nor `scroll-behavior` is reachable from
 * inside the panel, so the only lever is to take the gesture over and apply
 * the delta in one frame.
 *
 * One capture-phase listener at the document level keeps every scrollable box
 * — transcript, session list, pickers, tool output — at the same speed.
 * Boundaries stay the browser's job: when the box under the pointer cannot
 * move in the gesture's direction the event is left alone, so native chaining
 * to the next scrollable ancestor still happens (the 022 scroll-chaining
 * latch fix rides on exactly that behaviour).
 *
 * Opt-outs, in order of precedence:
 *  - ctrl/meta (pinch-zoom), and horizontal-dominant gestures: untouched;
 *  - any open modal (`[aria-modal="true"]`): untouched — the two dialogs
 *    preventDefault their own wheel to keep the page behind them still, and a
 *    capture-phase listener would run *before* their React handler;
 *  - `[data-no-wheel-gain]`: escape hatch for a scroller that wants the raw
 *    gesture.
 */

/**
 * 1.0 — measured, not guessed (`web/probe-wheel-scale.mjs`, WebStorm/JCEF,
 * 463×916 panel): one real detent arrives as deltaY=100 and Chromium moves
 * exactly 100px, which is already ~1.7× the IDE editor's three lines (58px).
 * The distance was never the problem; the *animation* was — the same 100px
 * took 190ms to settle (25ms→6px, 58ms→24px, 108ms→66px, 191ms→100px), so a
 * second notch queued behind the first and the view fell behind the hand.
 * With the takeover the same notch lands in one frame.
 *
 * Left as a named constant because taste still gets a vote: 1.25/1.5 make each
 * notch proportionally longer (measured 150px at 1.5), which is one line to
 * change if this turns out too timid on a real desk.
 */
export const WHEEL_GAIN = 1;

/**
 * A detent is ~100px; trackpad and touch gestures arrive as a dribble of a few
 * pixels each. Those are left to the browser: their motion is continuous, so
 * the animation is doing real smoothing work rather than adding lag.
 */
export const NOTCH_MIN_PX = 40;

/** CSS pixels an event of `deltaY` moves, for the three delta modes. */
export function wheelPixels(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (deltaMode === 1) return deltaY * 16; // DOM_DELTA_LINE
  if (deltaMode === 2) return deltaY * pageHeight; // DOM_DELTA_PAGE
  return deltaY; // DOM_DELTA_PIXEL
}

const scrollable = (el: Element): el is HTMLElement => {
  if (!(el instanceof HTMLElement)) return false;
  const oy = getComputedStyle(el).overflowY;
  if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return false;
  return el.scrollHeight - el.clientHeight > 1;
};

/**
 * The innermost ancestor that can actually take this gesture. A box already
 * parked at the edge the gesture would move away from is *not* it: swallowing
 * the notch there is what makes a long list feel stuck.
 */
export function findScroller(from: Element | null, deltaY: number): HTMLElement | null {
  let el: Element | null = from;
  while (el && el !== document.body && el !== document.documentElement) {
    if (scrollable(el)) {
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      if (!((deltaY < 0 && atTop) || (deltaY > 0 && atBottom))) return el;
    }
    el = el.parentElement;
  }
  return null;
}

function blockingModal(): boolean {
  return !!document.querySelector('[aria-modal="true"]');
}

/**
 * Installs the takeover once. Returns the remover — `main.tsx` keeps it so a
 * hot reload replaces the listener instead of stacking a second one (two
 * listeners means 2.25x, which is the kind of bug nobody attributes to HMR).
 */
export function installWheelGain(gain: number = WHEEL_GAIN): () => void {
  /** Is this gesture a detent (one notch) rather than a continuous dribble? */
  const isNotch = (event: WheelEvent) =>
    event.deltaMode === 2 ||
    Math.abs(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY) >= NOTCH_MIN_PX;

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) return;
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    if (!isNotch(event)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-no-wheel-gain]")) return;
    if (blockingModal()) return;

    const el = findScroller(target, event.deltaY);
    if (!el) return;

    const before = el.scrollTop;
    el.scrollTop = before + wheelPixels(event.deltaY, event.deltaMode, el.clientHeight) * gain;
    // Clamped to the edge: hand the rest back to the browser so it can chain.
    if (el.scrollTop === before) return;
    event.preventDefault();
  };

  document.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => document.removeEventListener("wheel", onWheel, { capture: true });
}
