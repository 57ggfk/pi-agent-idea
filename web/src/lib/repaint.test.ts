import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPAINT_DEBOUNCE_MS, cancelRepaint, requestRepaint, __setRepaintSenderForTests } from "./repaint";

/**
 * 021 T301: the JCEF frame workaround is now one debounced entry point. The
 * behaviour that matters is "a burst of view swaps paints once, and the last
 * one always paints" — the old call sites fired a request each.
 */
describe("requestRepaint", () => {
  let sent = 0;
  let restore: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = 0;
    restore = __setRepaintSenderForTests(() => {
      sent += 1;
      return Promise.resolve();
    });
  });

  afterEach(() => {
    restore();
    cancelRepaint();
    vi.useRealTimers();
  });

  it("coalesces three calls inside the window into one repaint", () => {
    requestRepaint();
    requestRepaint();
    requestRepaint();
    expect(sent).toBe(0); // trailing edge: nothing has been sent yet

    vi.advanceTimersByTime(REPAINT_DEBOUNCE_MS);
    expect(sent).toBe(1);
  });

  it("paints again for a request that arrives after the window", () => {
    requestRepaint();
    vi.advanceTimersByTime(REPAINT_DEBOUNCE_MS);
    requestRepaint();
    vi.advanceTimersByTime(REPAINT_DEBOUNCE_MS);
    expect(sent).toBe(2);
  });

  it("a cancelled request never paints", () => {
    requestRepaint();
    cancelRepaint();
    vi.advanceTimersByTime(REPAINT_DEBOUNCE_MS);
    expect(sent).toBe(0);
  });

  it("stays silent when the sender rejects (no bridge in a plain browser)", async () => {
    restore();
    restore = __setRepaintSenderForTests(() => Promise.reject(new Error("no bridge")));
    expect(() => {
      requestRepaint();
      vi.advanceTimersByTime(REPAINT_DEBOUNCE_MS);
    }).not.toThrow();
    await Promise.resolve();
  });
});
