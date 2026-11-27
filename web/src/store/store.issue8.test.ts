import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyItem } from "./types";
import type { QueueItem } from "./types";

/**
 * Issue #8 — the steer (插话) consistency between the queue and the
 * transcript.
 *
 * The same steer text lives in two places: the queue mirror (the plugin's
 * copy of pi's steering array) and the transcript (the ephemeral item the
 * plugin renders at fire time). The mirror is the truth about the queue, but
 * a steer leaves it for three different reasons — pi consumed it, the user
 * deleted it, the user took it back — and only the frontend knows which one
 * it caused. These tests pin that distinction.
 */

type Call = { method: string; params: Record<string, unknown> };

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    rpc: new Map<string, (cmd: Record<string, unknown>) => unknown>(),
    methods: new Map<string, (params: unknown) => unknown>(),
    /** Registered by init(); tests dispatch bridge events through it. */
    piHandler: null as ((name: string, data: unknown) => void) | null,
  };
  const bridge = {
    kind: "mock" as const,
    request<T>(method: string, params?: unknown): Promise<T> {
      state.calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === "rpc.request") {
        const cmd = ((params as { command?: Record<string, unknown> })?.command ?? {}) as Record<string, unknown>;
        const type = String(cmd["type"]);
        const handler = state.rpc.get(type);
        if (!handler) return Promise.resolve({ success: true, data: {} } as T);
        try {
          return Promise.resolve({ success: true, data: handler(cmd) } as T);
        } catch (e) {
          return Promise.resolve({ success: false, error: (e as Error).message } as T);
        }
      }
      const handler = state.methods.get(method);
      return Promise.resolve((handler ? handler(params) : {}) as T);
    },
    onEvent(handler: (name: string, data: unknown) => void) {
      state.piHandler = handler;
    },
  };
  return { state, bridge };
});

vi.mock("../bridge", () => ({ getBridge: () => Promise.resolve(h.bridge) }));

import { usePiStore } from "./store";
import { i18n } from "../i18n";

const STEER_TEXT = "interrupt the run";

/** A queue mirror entry. */
const mirrorItem = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: "q-1",
  mode: "steer",
  text: STEER_TEXT,
  images: [],
  status: "queued",
  createdAt: 1,
  ...over,
});

/** Pushes a queue_state snapshot, exactly like the Kotlin service does. */
function queueState(items: QueueItem[]): void {
  h.state.piHandler?.("queue", {
    type: "queue_state",
    items,
    paused: false,
    pauseReason: null,
    drift: false,
  });
}

const steerIn = () => usePiStore.getState().items.find((i) => i.steer);

describe("issue #8 — steer state in the transcript", () => {
  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({
      items: [],
      isStreaming: false,
      editing: null,
      pendingPrompt: null,
      queue: { items: [], paused: false, pauseReason: null, drift: false },
      queueDiscardConfirm: null,
    });
  });

  it("a fired steer lands in the transcript as queued (FR-003)", async () => {
    h.state.methods.set("queue.enqueue", () => ({ ok: true, id: "q-1" }));
    usePiStore.setState({ isStreaming: true });

    await usePiStore.getState().sendImages(STEER_TEXT, [], "steer");

    const item = steerIn();
    expect(item).toBeDefined();
    expect(item?.steerState).toBe("queued");
  });

  it("a steer that leaves the mirror is marked injected (FR-003)", async () => {
    h.state.methods.set("queue.enqueue", () => ({ ok: true, id: "q-1" }));
    usePiStore.setState({ isStreaming: true });
    await usePiStore.getState().sendImages(STEER_TEXT, [], "steer");

    // pi consumed it → the text is gone from the mirror.
    queueState([]);

    expect(steerIn()?.steerState).toBe("injected");
  });

  it("a steer that only changes mode is still queued (FR-003)", async () => {
    h.state.methods.set("queue.enqueue", () => ({ ok: true, id: "q-1" }));
    usePiStore.setState({ isStreaming: true });
    await usePiStore.getState().sendImages(STEER_TEXT, [], "steer");

    // Promoted to a follow-up: the text is still there, only the mode moved.
    queueState([mirrorItem({ mode: "followUp" })]);

    expect(steerIn()?.steerState).toBe("queued");
  });

  it("deleting the queue entry withdraws the transcript copy — it is not 'injected'", async () => {
    h.state.methods.set("queue.enqueue", () => ({ ok: true, id: "q-1" }));
    usePiStore.setState({ isStreaming: true });
    await usePiStore.getState().sendImages(STEER_TEXT, [], "steer");
    queueState([mirrorItem()]);

    // The service pushes the new snapshot while answering the request — the
    // disappearance arrives BEFORE the request resolves.
    h.state.methods.set("queue.remove", () => {
      queueState([]);
      return { ok: true };
    });

    await usePiStore.getState().queueRemove("q-1");

    expect(steerIn()).toBeUndefined();
    // A later snapshot must not resurrect it as "injected".
    queueState([]);
    expect(steerIn()).toBeUndefined();
  });

  it("a failed delete keeps the transcript copy (the entry is still queued)", async () => {
    h.state.methods.set("queue.enqueue", () => ({ ok: true, id: "q-1" }));
    usePiStore.setState({ isStreaming: true });
    await usePiStore.getState().sendImages(STEER_TEXT, [], "steer");
    queueState([mirrorItem()]);

    h.state.methods.set("queue.remove", () => ({ ok: false, error: "nope" }));

    await usePiStore.getState().queueRemove("q-1");

    expect(steerIn()?.steerState).toBe("queued");
  });

  it("taking a queued steer back withdraws the transcript copy and fills the composer (FR-001)", async () => {
    h.state.methods.set("queue.enqueue", () => ({ ok: true, id: "q-1" }));
    usePiStore.setState({ isStreaming: true });
    await usePiStore.getState().sendImages(STEER_TEXT, [], "steer");
    queueState([mirrorItem()]);

    h.state.methods.set("queue.restore", () => {
      queueState([]);
      return { ok: true, text: STEER_TEXT, images: [] };
    });

    const ok = await usePiStore.getState().queueRestore("q-1");

    expect(ok).toBe(true);
    expect(steerIn()).toBeUndefined();
    expect(usePiStore.getState().pendingPrompt?.text).toBe(STEER_TEXT);
    // A later snapshot must not bring it back as "injected".
    queueState([]);
    expect(steerIn()).toBeUndefined();
  });

  it("taking back an injected steer keeps the transcript copy and says so (FR-004)", async () => {
    h.state.methods.set("queue.enqueue", () => ({ ok: true, id: "q-1" }));
    usePiStore.setState({ isStreaming: true });
    await usePiStore.getState().sendImages(STEER_TEXT, [], "steer");
    // pi took it → the transcript copy is "injected".
    queueState([]);

    h.state.methods.set("queue.restore", () => ({ ok: true, text: STEER_TEXT, images: [] }));

    const ok = await usePiStore.getState().queueRestore("q-1");

    expect(ok).toBe(true);
    // It is in pi's context now: it must not vanish from the transcript.
    expect(steerIn()?.steerState).toBe("injected");
    // The text still reaches the composer, and the user is told in words.
    expect(usePiStore.getState().pendingPrompt?.text).toBe(STEER_TEXT);
    const notice = usePiStore.getState().items.find((i) => i.isError);
    expect(notice).toBeDefined();
    expect((notice?.blocks[0] as { text?: string })?.text).toBe(i18n.t("queue.restore.injected"));
  });

  it("a queue snapshot without steers leaves the transcript untouched (FR-005)", async () => {
    const plain = emptyItem("user", [{ kind: "text", text: "hello", done: true }]);
    plain.done = true;
    usePiStore.setState({ items: [plain] });

    queueState([mirrorItem({ mode: "followUp", text: "something else" })]);

    expect(usePiStore.getState().items).toHaveLength(1);
    expect(usePiStore.getState().items[0].steer).toBeUndefined();
  });

  it("a re-fired steer with the same text is queued again", async () => {
    h.state.methods.set("queue.enqueue", () => ({ ok: true, id: "q-1" }));
    usePiStore.setState({ isStreaming: true });
    await usePiStore.getState().sendImages(STEER_TEXT, [], "steer");
    queueState([mirrorItem()]);
    h.state.methods.set("queue.remove", () => ({ ok: true }));
    await usePiStore.getState().queueRemove("q-1");

    // The same text again: a new entry, not the withdrawn one.
    await usePiStore.getState().sendImages(STEER_TEXT, [], "steer");

    expect(steerIn()?.steerState).toBe("queued");
  });
});
