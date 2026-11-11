import { describe, expect, it, vi, afterEach } from "vitest";
import { withTimeout } from "./timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("resolves with the underlying value when it arrives in time", async () => {
    vi.useFakeTimers();
    const p = withTimeout(Promise.resolve("ok"), 5_000, "switch_session");
    await expect(p).resolves.toBe("ok");
  });

  it("rejects with a labelled error when the deadline passes first", async () => {
    vi.useFakeTimers();
    const gate = new Promise<string>(() => {});
    const p = withTimeout(gate, 5_000, "switch_session");
    const expectation = expect(p).rejects.toThrow("switch_session timeout");
    vi.advanceTimersByTime(5_001);
    await expectation;
  });

  it("does not flip a settled result when a late resolve arrives", async () => {
    vi.useFakeTimers();
    let resolveLate!: (v: string) => void;
    const gate = new Promise<string>((r) => (resolveLate = r));
    const p = withTimeout(gate, 1_000, "slow_thing");
    const expectation = expect(p).rejects.toThrow("slow_thing timeout");
    vi.advanceTimersByTime(1_001);
    await expectation;
    resolveLate("late");
    await vi.advanceTimersByTimeAsync(10);
    // Still the timeout rejection — a settled race cannot be un-settled.
    await expect(p).rejects.toThrow("slow_thing timeout");
  });

  it("swallows a late rejection instead of leaving it unhandled", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);

    let rejectLate!: (e: Error) => void;
    const gate = new Promise<string>((_, rej) => (rejectLate = rej));
    const p = withTimeout(gate, 1_000, "late_reject");
    const expectation = expect(p).rejects.toThrow("late_reject timeout");
    vi.advanceTimersByTime(1_001);
    await expectation;
    rejectLate(new Error("bridge died late"));
    await vi.advanceTimersByTimeAsync(10);
    expect(unhandled).toEqual([]);
    process.off("unhandledRejection", onUnhandled);
  });

  it("propagates an in-time rejection with its original error", async () => {
    vi.useFakeTimers();
    const p = withTimeout(Promise.reject(new Error("rpc refused")), 5_000, "cmd");
    await expect(p).rejects.toThrow("rpc refused");
  });
});
