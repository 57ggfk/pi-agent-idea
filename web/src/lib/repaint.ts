import { getBridge } from "../bridge";

/**
 * Single entry point for the JCEF "force a frame" workaround (021 D4).
 *
 * JCEF's OSR pipeline can leave the previous paint on screen for seconds after
 * a full view swap (0.5.4 real-machine find), so a swap must ask the IDE to
 * revalidate the browser. Today the calls are scattered (tab clicks, Manage
 * sub-tabs) and a session switch swaps the view twice in a row — two bare
 * `wasResized` round-trips that fight each other.
 *
 * Coalescing window: the first request schedules one call, everything asked
 * for inside the next `REPAINT_DEBOUNCE_MS` rides along (trailing edge, so the
 * last state always gets painted). Without a bridge (plain browser / tests)
 * the call is a silent no-op.
 */
export const REPAINT_DEBOUNCE_MS = 100;

let timer: ReturnType<typeof setTimeout> | null = null;
/** Test seam: null means "use the real bridge". */
let sender: (() => Promise<unknown>) | null = null;

function defaultSend(): Promise<unknown> {
  return getBridge()
    .then((b) => b.request("ide.repaint"))
    .catch(() => undefined);
}

/** For tests: replaces the bridge lookup; returns a restore function. */
export function __setRepaintSenderForTests(send: (() => Promise<unknown>) | null): () => void {
  const previous = sender;
  sender = send;
  return () => {
    sender = previous;
  };
}

/** Drops a pending repaint (tests / teardown). */
export function cancelRepaint(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

export function requestRepaint(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      void Promise.resolve((sender ?? defaultSend)()).catch(() => undefined);
    } catch {
      // No bridge / torn-down page: repainting is best effort by definition.
    }
  }, REPAINT_DEBOUNCE_MS);
}
