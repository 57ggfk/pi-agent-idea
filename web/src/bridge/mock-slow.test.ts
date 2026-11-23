import { describe, expect, it, vi } from "vitest";
import { MockBridge } from "./mock";

// -- 021 T315: `?slow=` also accepts rpc command names ------------------------

describe("MockBridge ?slow= on rpc commands", () => {
  it("delays the first call of a named command only", async () => {
    vi.stubGlobal("location", { search: "?slow=switch_session:300" });
    // Fake clock: the wall clock is not the thing under test, and a busy
    // machine can push a plain in-memory call past 50ms — this file failed
    // 3 times out of 8 while gradle + a browser were running (55/60/67ms).
    // The clock only has to show "the first call waited, the second did not".
    vi.useFakeTimers();
    try {
      const bridge = new MockBridge();
      const started = Date.now();
      const first = bridge.request("rpc.request", { command: { type: "switch_session", sessionPath: "/tmp/x" } });
      await vi.advanceTimersByTimeAsync(300);
      await first;
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);

      const again = Date.now();
      await bridge.request("rpc.request", { command: { type: "switch_session", sessionPath: "/tmp/x" } });
      expect(Date.now() - again).toBeLessThan(50);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("leaves other commands at full speed", async () => {
    vi.stubGlobal("location", { search: "?slow=switch_session:300" });
    vi.useFakeTimers();
    try {
      const bridge = new MockBridge();
      const started = Date.now();
      await bridge.request("rpc.request", { command: { type: "get_state" } });
      expect(Date.now() - started).toBeLessThan(50);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
