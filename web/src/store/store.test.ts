import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyItem } from "./types";

/**
 * Store orchestration for message-level actions.
 *
 * These drive the real store against a recording bridge: the point is the RPC
 * *sequence* (fork → replay → prompt), which cannot be observed from the UI and
 * is where a wrong order silently corrupts the transcript.
 */

type Call = { method: string; params: Record<string, unknown> };

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    rpc: new Map<string, (cmd: Record<string, unknown>) => unknown>(),
    methods: new Map<string, (params: unknown) => unknown>(),
  };
  const bridge = {
    kind: "mock" as const,
    request<T>(method: string, params?: unknown): Promise<T> {
      state.calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === "rpc.request") {
        const cmd = ((params as { command?: Record<string, unknown> })?.command ?? {}) as Record<
          string,
          unknown
        >;
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
    onEvent() {
      // No event stream in these tests: every assertion is on the RPC side.
    },
  };
  return { state, bridge };
});

vi.mock("../bridge", () => ({ getBridge: () => Promise.resolve(h.bridge) }));

import { usePiStore } from "./store";

/** Commands actually sent to pi, in order, flattened to their type. */
function commandTypes(): string[] {
  return h.state.calls
    .filter((c) => c.method === "rpc.request")
    .map((c) => String((c.params["command"] as Record<string, unknown>)["type"]));
}

function command<T extends Record<string, unknown> = Record<string, unknown>>(type: string): T[] {
  return h.state.calls
    .filter((c) => c.method === "rpc.request")
    .map((c) => c.params["command"] as Record<string, unknown>)
    .filter((c) => String(c["type"]) === type) as T[];
}

/** Only the transcript-rewriting commands — the interesting subsequence. */
function branchTypes(): string[] {
  return commandTypes().filter((t) => ["get_fork_messages", "fork", "get_messages", "prompt"].includes(t));
}

const userItem = (text: string) => {
  const item = emptyItem("user", [{ kind: "text", text, done: true }]);
  item.done = true;
  return item;
};

const assistantItem = (text: string) => {
  const item = emptyItem("assistant", [{ kind: "text", text, done: true }]);
  item.done = true;
  return item;
};

describe("message actions: store orchestration", () => {
  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    h.state.rpc.set("get_fork_messages", () => [
      { entryId: "entry-1", text: "first question" },
      { entryId: "entry-2", text: "second question" },
    ]);
    h.state.rpc.set("fork", () => ({ text: "second question", cancelled: false }));
    h.state.rpc.set("get_messages", () => ({ messages: [] }));
    h.state.rpc.set("get_state", () => ({ sessionId: "branch-1" }));
    usePiStore.setState({
      items: [userItem("second question"), assistantItem("old answer")],
      isStreaming: false,
      editing: null,
      pendingPrompt: null,
    });
  });

  it("quoteToComposer hands the composer a blockquote in quote mode (FR-006)", () => {
    usePiStore.getState().quoteToComposer(assistantItem("line one\n\nline two"));
    const pending = usePiStore.getState().pendingPrompt;
    expect(pending?.mode).toBe("quote");
    expect(pending?.text).toBe("> line one\n>\n> line two");
  });

  it("quoteToComposer does nothing for a pure-image message (FR-007)", () => {
    const item = emptyItem("user", [{ kind: "image", data: "AA", mimeType: "image/png" }]);
    item.done = true;
    usePiStore.getState().quoteToComposer(item);
    expect(usePiStore.getState().pendingPrompt).toBeNull();
  });

  it("regenerate branches at the last user entry, replays, then re-asks verbatim", async () => {
    await usePiStore.getState().regenerate();

    expect(branchTypes()).toEqual(["get_fork_messages", "fork", "get_messages", "prompt"]);
    expect(command("fork")[0]["entryId"]).toBe("entry-2");
    // The re-ask must be the forked prompt, not a rewritten one.
    expect(command("prompt")[0]["message"]).toBe("second question");
  });

  it("regenerate refuses while a run is in flight and says why (FR-010)", async () => {
    usePiStore.setState({ isStreaming: true });
    await usePiStore.getState().regenerate();

    expect(commandTypes()).not.toContain("fork");
    const last = usePiStore.getState().items.at(-1);
    expect(last?.isError).toBe(true);
    expect(last?.blocks[0]).toMatchObject({ kind: "text", text: expect.stringContaining("idle") });
  });

  it("regenerate reports a cancelled fork instead of silently doing nothing", async () => {
    h.state.rpc.set("fork", () => ({ cancelled: true }));
    await usePiStore.getState().regenerate();

    expect(commandTypes()).not.toContain("prompt");
    expect(usePiStore.getState().items.at(-1)?.isError).toBe(true);
  });

  it("beginEditMessage never forks — cancelling has to stay side-effect free (US4-3)", async () => {
    const item = userItem("second question");
    await usePiStore.getState().beginEditMessage(item);

    expect(commandTypes()).not.toContain("fork");
    expect(usePiStore.getState().editing).toEqual({ entryId: "entry-2", text: "second question" });
    expect(usePiStore.getState().pendingPrompt).toMatchObject({
      mode: "edit",
      text: "second question",
    });
  });

  it("cancelEditMessage clears the target and leaves the transcript alone", async () => {
    const before = usePiStore.getState().items;
    await usePiStore.getState().beginEditMessage(userItem("second question"));
    usePiStore.getState().cancelEditMessage();

    expect(usePiStore.getState().editing).toBeNull();
    expect(usePiStore.getState().items).toBe(before);
  });

  it("sendEdited branches at the stored entry, then sends the new text", async () => {
    h.state.rpc.set("get_messages", () => ({
      messages: [{ role: "user", content: "first question" }],
    }));
    await usePiStore.getState().beginEditMessage(userItem("second question"));
    await usePiStore.getState().sendEdited("second question, reworded");

    expect(branchTypes()).toEqual(["get_fork_messages", "fork", "get_messages", "prompt"]);
    expect(command("fork")[0]["entryId"]).toBe("entry-2");
    expect(command("prompt")[0]["message"]).toBe("second question, reworded");
    // The old version and the answer it produced are gone after the replay.
    const texts = usePiStore
      .getState()
      .items.flatMap((i) => i.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])));
    expect(texts).not.toContain("old answer");
    expect(texts).toContain("second question, reworded");
    expect(usePiStore.getState().editing).toBeNull();
  });

  it("sendEdited refuses an empty edit instead of overwriting with nothing", async () => {
    await usePiStore.getState().beginEditMessage(userItem("second question"));
    await usePiStore.getState().sendEdited("   ");

    expect(commandTypes()).not.toContain("fork");
    // Still editing: the user has not decided anything yet.
    expect(usePiStore.getState().editing).not.toBeNull();
  });
});
