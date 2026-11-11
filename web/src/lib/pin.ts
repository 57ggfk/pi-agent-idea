/**
 * 022 D4 — "should the transcript follow new content?" as an explicit state
 * machine instead of a distance check.
 *
 * The old rule was `scrollHeight - scrollTop - clientHeight < 60`: a single
 * wheel notch (~100px, and the first notch at the bottom can be much smaller)
 * is the same order of magnitude, so scrolling up one step still counted as
 * "at the bottom" and the next message update yanked the view back. Direction
 * wins over distance now: an upward gesture always unpins, no matter how close
 * the bottom is. The 4px tolerance only absorbs sub-pixel rounding.
 *
 * Two signals feed it:
 * - `userScrolledUp`: the app saw a wheel-up / up-key gesture (explicit);
 * - a shorter scrollTop at an unchanged scrollHeight (inferred — deliberately
 *   conservative, because `content-visibility` re-measuring can shrink
 *   scrollHeight and clamp the offset without any user involvement).
 */

export interface PinState {
  /** Follow new content (keep the view at the bottom)? */
  pinned: boolean;
  /** Previous `scrollTop`, for the inferred direction test. */
  lastTop: number;
  /** Previous `scrollHeight`, so a clamp is not mistaken for a gesture. */
  lastHeight: number;
}

export const BOTTOM_EPS = 4;

export function initialPin(): PinState {
  return { pinned: true, lastTop: 0, lastHeight: 0 };
}

export function nextPin(
  state: PinState,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  userScrolledUp = false,
): PinState {
  // 1) An explicit upward gesture — unpin immediately, however close the
  //    bottom is. This is the "滑到底再往上滑不动" fix.
  if (userScrolledUp) return { pinned: false, lastTop: scrollTop, lastHeight: scrollHeight };
  // 2) Inferred upward move: the offset shrank and the content size is
  //    unchanged (any size change means the geometry, not the user, moved it).
  if (scrollTop < state.lastTop && scrollHeight === state.lastHeight) {
    return { pinned: false, lastTop: scrollTop, lastHeight: scrollHeight };
  }
  // 3) Settled at the very bottom — pin again.
  if (scrollHeight - scrollTop - clientHeight <= BOTTOM_EPS) {
    return { pinned: true, lastTop: scrollTop, lastHeight: scrollHeight };
  }
  // 4) Anywhere else (content grew under a pinned view, or an unpinned view is
  //    scrolled down) — keep the previous intent instead of guessing.
  return { pinned: state.pinned, lastTop: scrollTop, lastHeight: scrollHeight };
}

/** The view follows new content while pinned. */
export function shouldStick(state: PinState): boolean {
  return state.pinned;
}

/** Where the pinned view should scroll to after new content was appended. */
export function pinnedScrollTop(scrollHeight: number): number {
  return scrollHeight;
}
