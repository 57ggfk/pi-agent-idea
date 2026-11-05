/**
 * The one and only composer height policy (spec 010 US3 / plan D3).
 *
 * Every path that puts text into the composer — user typing, IDE actions,
 * quote, queue take-back, `@` completion, directory injection, edit refill —
 * grows the textarea through `autosize`, and the cap lives in one place that
 * both CSS (`--composer-max-h`) and JS read. Before this module the cap was
 * `160px` in JS and `140px` in CSS at the same time, disagreeing silently.
 */

/** Absolute cap, so a very tall tool window cannot let the composer eat the
 *  message list (FR-007: `min(320px, 45% × app height)`). */
export const MAX_COMPOSER_CAP = 320;

/** Fraction of the app height the composer may take before it scrolls inside. */
const VIEWPORT_SHARE = 0.45;

/** Single-line height: `.composer-input` is `rows={1}`, padding 4/6 and
 *  `line-height: 1.5` at `--fs-base` 13px → 19.5 + 10 + borders. The exact
 *  value does not matter as long as it is the measured single-line height —
 *  `autosize` derives it from the element itself, this constant is only the
 *  floor for the pure `clampComposerHeight`. */
export const MIN_COMPOSER_HEIGHT = 34;

/** `min(320, 0.45 × appHeight)` — the cap CSS and JS share. Never negative. */
export function composerMaxHeight(appHeight: number): number {
  const byViewport = Number.isFinite(appHeight) ? appHeight * VIEWPORT_SHARE : 0;
  const cap = MAX_COMPOSER_CAP < byViewport ? MAX_COMPOSER_CAP : byViewport;
  return Math.floor(Math.max(0, cap));
}

/** One clamp step, pure so the policy can be unit-tested without a DOM. */
export function clampComposerHeight(contentHeight: number, appHeight: number): number {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return MIN_COMPOSER_HEIGHT;
  const cap = Math.max(composerMaxHeight(appHeight), MIN_COMPOSER_HEIGHT);
  return Math.min(Math.max(contentHeight, MIN_COMPOSER_HEIGHT), cap);
}

/**
 * Grows the textarea to its content, capped by the app height. Sets
 * `--composer-max-h` on the app element so the CSS `max-height` and this
 * computation can never drift apart (plan D3: one source of truth).
 */
export function autosize(ta: HTMLTextAreaElement, appEl?: HTMLElement | null): void {
  const app = appEl ?? (ta.closest(".app") as HTMLElement | null);
  const cap = composerMaxHeight(app?.clientHeight ?? 0);
  if (app) app.style.setProperty("--composer-max-h", `${cap}px`);
  ta.style.height = "auto";
  ta.style.height = `${clampComposerHeight(ta.scrollHeight, app?.clientHeight ?? 0)}px`;
}

/** After sending (FR-008): back to a single line immediately. */
export function resetComposerHeight(ta: HTMLTextAreaElement, appEl?: HTMLElement | null): void {
  ta.style.height = "";
  autosize(ta, appEl);
}
