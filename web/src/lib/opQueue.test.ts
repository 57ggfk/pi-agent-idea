import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  managementQueueRun,
  managementQueueSnapshot,
  managementQueueSubscribe,
  managementQueueIdle,
} from "./opQueue";

/** Spec 035: FIFO serial queue — failures never stall later items, snapshots
 *  are immutable, duplicate keys collapse. */
describe("management operation queue (035)", () => {
  beforeEach(async () => {
    await managementQueueIdle();
  });

  it("runs enqueued operations in FIFO order", async () => {
    const order: string[] = [];
    const op = (name: string, ms: number) => () =>
      new Promise((r) => setTimeout(() => { order.push(name); r(name); }, ms));

    await Promise.all([
      managementQueueRun("a", op("a", 30)),
      managementQueueRun("b", op("b", 10)),
      managementQueueRun("c", op("c", 5)),
    ]);

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("a failing operation rejects its caller but the queue keeps going", async () => {
    const order: string[] = [];
    await managementQueueRun("boom", async () => {
      order.push("boom-start");
      throw new Error("dead");
    }).catch(() => undefined);

    await managementQueueRun("after", async () => { order.push("after"); });

    expect(order).toEqual(["boom-start", "after"]);
  });

  it("snapshot exposes active and waiting keys, live", async () => {
    const seen: Array<{ active: string | null; waiting: string[] }> = [];
    const unsub = managementQueueSubscribe(() => {
      const snap = managementQueueSnapshot();
      if (snap.active) seen.push(snap);
    });

    const slow = managementQueueRun("slow", () => new Promise((r) => setTimeout(r, 40)));
    await managementQueueRun("quick", async () => {
      seen.push(managementQueueSnapshot());
    });
    await slow;
    unsub();

    const whileSlow = seen.find((s) => s.active === "slow");
    expect(whileSlow?.waiting).toContain("quick");
    expect(managementQueueSnapshot()).toEqual({ active: null, waiting: [] });
  });

  it("duplicate keys collapse: the second enqueue is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const first = managementQueueRun("dup", () => gate.then(() => "first"));
    await vi.waitFor(() => expect(managementQueueSnapshot().active).toBe("dup"));

    await expect(managementQueueRun("dup", async () => "second")).rejects.toThrow(/already queued/);

    release();
    await expect(first).resolves.toBe("first");
    await managementQueueIdle();
  });

  it("idle drain waits for the chain", async () => {
    let done = false;
    await managementQueueRun("x", async () => { await new Promise((r) => setTimeout(r, 20)); done = true; });
    await managementQueueIdle();
    expect(done).toBe(true);
  });
});
