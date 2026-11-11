import { describe, expect, it, vi } from "vitest";
import { MockBridge } from "./mock";

// -- 021 T315: `?slow=` also accepts rpc command names ------------------------

describe("MockBridge ?slow= on rpc commands", () => {
  it("delays the first call of a named command only", async () => {
    vi.stubGlobal("location", { search: "?slow=switch_session:300" });
    try {
      const bridge = new MockBridge();
      const started = Date.now();
      await bridge.request("rpc.request", { command: { type: "switch_session", sessionPath: "/tmp/x" } });
      const first = Date.now() - started;
      expect(first).toBeGreaterThanOrEqual(250);

      const again = Date.now();
      await bridge.request("rpc.request", { command: { type: "switch_session", sessionPath: "/tmp/x" } });
      expect(Date.now() - again).toBeLessThan(50);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves other commands at full speed", async () => {
    vi.stubGlobal("location", { search: "?slow=switch_session:300" });
    try {
      const bridge = new MockBridge();
      const started = Date.now();
      await bridge.request("rpc.request", { command: { type: "get_state" } });
      expect(Date.now() - started).toBeLessThan(50);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
