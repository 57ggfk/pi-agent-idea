import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The transport used inside the IDE. Both cases here are the ones that made a
 * real panel stop working after hours of idling (2026-11-09): a poll request
 * that never settles, and a renderer that quietly stops running the page.
 * Neither surfaces as an error in the UI, so the loop has to defend itself.
 */

type JcefModule = typeof import("./jcef");

const okResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ events: [], cursor: 0 }),
});

/** A fetch that hangs like a half-open loopback socket: only abort ends it. */
function hanging(init?: RequestInit): Promise<never> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

describe("JcefBridge transport resilience", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { location: { search: "?token=test-token" } });
    reload = vi.fn();
    vi.stubGlobal("location", { reload });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadBridge(): Promise<JcefModule> {
    // Imported after the globals exist: the module reads the token at load.
    return await import("./jcef");
  }

  it("aborts a poll that never settles, then retries", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, init });
        // First request hangs; the retry hangs too — we only assert that the
        // abort turned "forever" into "retry after the backoff".
        return hanging(init);
      }),
    );

    const { JcefBridge } = await loadBridge();
    new JcefBridge();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    // Without this signal the loop parks on the await forever.
    expect(calls[0].init?.signal).toBeDefined();

    // 35s poll timeout fires the abort, then the 1s backoff before the retry.
    await vi.advanceTimersByTimeAsync(36_500);
    expect(calls.length).toBe(2);
  });

  it("reloads the page after 90s without a successful poll", async () => {
    let firstPollDone = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        if (!firstPollDone) {
          firstPollDone = true;
          return Promise.resolve(okResponse());
        }
        // Everything after the first success hangs: frozen renderer, wedged
        // socket, IDE suspended. The poll loop itself cannot recover.
        return new Promise(() => {});
      }),
    );

    const { JcefBridge } = await loadBridge();
    new JcefBridge();

    await vi.advanceTimersByTimeAsync(0);
    expect(firstPollDone).toBe(true);
    expect(reload).not.toHaveBeenCalled();

    // Watchdog scans every 5s; 90s after the last good poll it must reload.
    await vi.advanceTimersByTimeAsync(95_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload before a poll has ever succeeded", async () => {
    // A bridge that never reached the server (IDE still starting) must not
    // enter a reload loop: there is nothing to heal yet.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("connection refused"))),
    );

    const { JcefBridge } = await loadBridge();
    new JcefBridge();

    await vi.advanceTimersByTimeAsync(200_000);
    expect(reload).not.toHaveBeenCalled();
  });
});
