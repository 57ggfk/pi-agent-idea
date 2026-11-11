import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptySources } from "./sources";
import { emptyItem } from "./types";

/**
 * Store orchestration for message-level actions.
 *
 * These drive the real store against a recording bridge: the point is the RPC
 * *sequence* (fork → replay → prompt), which cannot be observed from the UI and
 * is where a wrong order silently corrupts the transcript.
 */

type Call = { method: string; params: Record<string, unknown>; at: number };

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    rpc: new Map<string, (cmd: Record<string, unknown>) => unknown>(),
    methods: new Map<string, (params: unknown) => unknown>(),
    /** Registered by init(); tests dispatch pi events through it. */
    piHandler: null as ((name: string, data: unknown) => void) | null,
  };
  const bridge = {
    kind: "mock" as const,
    request<T>(method: string, params?: unknown): Promise<T> {
      state.calls.push({ method, params: (params ?? {}) as Record<string, unknown>, at: Date.now() });
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
    onEvent(handler: (name: string, data: unknown) => void) {
      state.piHandler = handler;
    },
  };
  return { state, bridge };
});

vi.mock("../bridge", () => ({ getBridge: () => Promise.resolve(h.bridge) }));

import { usePiStore, branchTargetFor, isSwitchLong, userCountUpTo } from "./store";

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

describe("branch point resolution (spec 007, pi 1.5.0 semantics)", () => {
  it("counts the user messages at or above an index", () => {
    const items = [userItem("q1"), assistantItem("a1"), userItem("q2"), assistantItem("a2")];
    expect(userCountUpTo(items, 0)).toBe(1);
    expect(userCountUpTo(items, 1)).toBe(1);
    expect(userCountUpTo(items, 2)).toBe(2);
    expect(userCountUpTo(items, 3)).toBe(2);
    expect(userCountUpTo(items, 99)).toBe(2);
  });

  it("branches a middle reply at the question that follows it", () => {
    // Two questions in the session, the reply answered the first one → the
    // branch point is q2, which yields exactly q1/a1.
    expect(branchTargetFor(1, 2)).toEqual({ kind: "entry", index: 1 });
  });

  it("clones for the last reply — there is no question after it", () => {
    expect(branchTargetFor(2, 2)).toEqual({ kind: "clone" });
  });

  it("falls back to clone when pi reports no forkable entry", () => {
    expect(branchTargetFor(0, 0)).toEqual({ kind: "clone" });
  });
});

describe("fork at a message: store orchestration (spec 007)", () => {
  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    h.state.rpc.set("get_fork_messages", () => ({
      messages: [
        { entryId: "entry-1", text: "q1" },
        { entryId: "entry-2", text: "q2" },
      ],
    }));
    h.state.rpc.set("fork", () => ({ text: "q2", cancelled: false }));
    h.state.rpc.set("clone", () => ({ cancelled: false }));
    h.state.rpc.set("get_messages", () => ({ messages: [] }));
    h.state.rpc.set("get_state", () => ({ sessionId: "branched" }));
    usePiStore.setState({
      items: [userItem("q1"), assistantItem("a1"), userItem("q2"), assistantItem("a2")],
      isStreaming: false,
      editing: null,
      pendingPrompt: null,
      confirm: null,
    });
  });

  const items = () => usePiStore.getState().items;

  it("asks first, explaining that the old session is kept (US3-4)", async () => {
    await usePiStore.getState().forkAtItem(items()[1].id);
    const ask = usePiStore.getState().confirm;
    expect(ask?.title).toBe("Fork from this reply?");
    expect(ask?.confirmLabel).toBe("Fork session");
    expect(ask?.message).toMatch(/current session stays/i);
    // Nothing ran yet — the dialog is the gate.
    expect(commandTypes()).not.toContain("fork");
  });

  it("forks a middle reply at the next question, then replays (US1-1)", async () => {
    await usePiStore.getState().forkAtItem(items()[1].id);
    await usePiStore.getState().confirm!.onConfirm();

    expect(command("fork")).toEqual([{ type: "fork", entryId: "entry-2" }]);
    expect(branchTypes()).toEqual(["get_fork_messages", "fork", "get_messages"]);
    expect(h.state.calls.some((c) => c.method === "sessions.list")).toBe(true);
    expect(command("clone")).toHaveLength(0);
  });

  it("clones for the last reply instead of dropping it (US1-2)", async () => {
    await usePiStore.getState().forkAtItem(items()[3].id);
    expect(usePiStore.getState().confirm?.message).toMatch(/whole conversation last|whole conversation/i);
    await usePiStore.getState().confirm!.onConfirm();

    expect(command("clone")).toHaveLength(1);
    expect(command("fork")).toHaveLength(0);
    expect(commandTypes()).toContain("get_messages");
  });

  it("cancel leaves the transcript and the session untouched (US1-5)", async () => {
    await usePiStore.getState().forkAtItem(items()[1].id);
    usePiStore.getState().closeConfirm();

    expect(usePiStore.getState().confirm).toBeNull();
    expect(commandTypes()).toEqual([]);
    expect(items()).toHaveLength(4);
  });

  it("keeps the view intact when a pi extension cancels the fork (US1-7)", async () => {
    h.state.rpc.set("fork", () => ({ cancelled: true }));
    await usePiStore.getState().forkAtItem(items()[1].id);
    await usePiStore.getState().confirm!.onConfirm();

    // No replay: the transcript is exactly what it was, plus the visible error.
    expect(commandTypes()).not.toContain("get_messages");
    expect(items().slice(0, 4).map((i) => i.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const last = items()[items().length - 1];
    expect(last.role).toBe("system");
    expect(last.isError).toBe(true);
  });

  it("refuses to fork while a run is in flight (FR-002)", async () => {
    usePiStore.setState({ isStreaming: true });
    await usePiStore.getState().forkAtItem(items()[1].id);
    expect(usePiStore.getState().confirm).toBeNull();
    expect(commandTypes()).toEqual([]);
  });

  it("refuses to fork a user message (FR-001)", async () => {
    await usePiStore.getState().forkAtItem(items()[0].id);
    expect(usePiStore.getState().confirm).toBeNull();
  });

  it("clears draft, edit target and queue after branching (FR-013)", async () => {
    usePiStore.setState({
      pendingPrompt: { text: "draft belonging to the old session", id: 1, mode: "replace" },
      queue: {
        items: [{ id: "q-1", mode: "steer", text: "queued", images: [], status: "queued", createdAt: 1 }],
        paused: false,
        pauseReason: null,
        drift: false,
      },
    });
    const before = usePiStore.getState().composerResetSeq;

    await usePiStore.getState().forkAtItem(items()[1].id);
    await usePiStore.getState().confirm!.onConfirm();

    const state = usePiStore.getState();
    expect(state.pendingPrompt).toBeNull();
    expect(state.editing).toBeNull();
    expect(state.queue.items).toHaveLength(0);
    // The Composer clears its local images on this bump.
    expect(state.composerResetSeq).toBe(before + 1);
  });
});

describe("data sources: loadSource orchestration (spec 003)", () => {
  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({ sources: emptySources(), files: [] });
  });

  it("runs a source read once even when two callers ask at the same time (FR-004)", async () => {
    let served = 0;
    let release!: (value: string[]) => void;
    const fetcher = () => {
      served += 1;
      return new Promise<string[]>((resolve) => {
        release = resolve;
      });
    };

    const first = usePiStore.getState().loadSource("files", fetcher);
    const second = usePiStore.getState().loadSource("files", fetcher);

    expect(served).toBe(1);
    expect(usePiStore.getState().sources.files.status).toBe("loading");
    expect(usePiStore.getState().sources.files.inflight).toBe(true);

    release(["a.ts"]);
    expect(await first).toEqual(["a.ts"]);
    expect(await second).toBeUndefined();
    expect(usePiStore.getState().sources.files.status).toBe("ready");
    expect(usePiStore.getState().sources.files.inflight).toBe(false);
  });

  it("records the error instead of swallowing it, and keeps the value undefined", async () => {
    const value = await usePiStore.getState().loadSource("commands", () =>
      Promise.reject(new Error("get_commands failed: pi is still starting")),
    );

    expect(value).toBeUndefined();
    const state = usePiStore.getState().sources.commands;
    expect(state.status).toBe("failed");
    expect(state.error).toContain("still starting");
    expect(state.retries).toBe(1);
  });

  it("retrySource re-runs the *last* fetcher, so a recovered read updates the store", async () => {
    let attempt = 0;
    await usePiStore.getState().loadSource("stats", async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return "second time lucky";
    });
    expect(usePiStore.getState().sources.stats.status).toBe("failed");

    await usePiStore.getState().retrySource("stats");

    expect(attempt).toBe(2);
    expect(usePiStore.getState().sources.stats.status).toBe("ready");
    expect(usePiStore.getState().sources.stats.error).toBeUndefined();
    expect(usePiStore.getState().sources.stats.retries).toBe(0);
  });

  it("marks a missing bridge method as unsupported, which is never a failure (FR-009)", async () => {
    await usePiStore.getState().loadSource("prefs", () =>
      Promise.reject(new Error("mock bridge: unsupported method config.getPrefs")),
    );
    expect(usePiStore.getState().sources.prefs.status).toBe("unsupported");
    // retryFailedSources must not chase it forever.
    usePiStore.getState().retryFailedSources();
    expect(usePiStore.getState().sources.prefs.status).toBe("unsupported");
  });

  it("retries every failed source at once but leaves healthy ones alone (FR-005)", async () => {
    await usePiStore.getState().loadSource("files", () => Promise.reject(new Error("nope")));
    await usePiStore.getState().loadSource("models", () => Promise.resolve(["m"]));
    const before = usePiStore.getState().sources.models.lastAttemptAt;

    usePiStore.getState().retryFailedSources();
    await new Promise((r) => setTimeout(r, 0));

    expect(usePiStore.getState().sources.files.status).toBe("failed");
    expect(usePiStore.getState().sources.models.lastAttemptAt).toBe(before);
  });
});

describe("message queue: store orchestration (spec 005)", () => {
  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.methods.clear();
    h.state.rpc.clear();
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

  it("a streaming send goes to queue.enqueue and never to prompt (FR-005)", async () => {
    h.state.methods.set("queue.enqueue", () => ({ ok: true, id: "q-1" }));
    usePiStore.setState({ isStreaming: true });

    await usePiStore.getState().sendImages("while busy", [], "followUp");

    expect(h.state.calls.some((c) => c.method === "queue.enqueue")).toBe(true);
    expect(
      h.state.calls.find((c) => c.method === "queue.enqueue")?.params["mode"],
    ).toBe("followUp");
    expect(commandTypes()).not.toContain("prompt");
  });

  it("an idle send goes straight to prompt in any mode (FR-006)", async () => {
    usePiStore.setState({ isStreaming: false });

    await usePiStore.getState().send("direct", "steer");

    expect(commandTypes()).toContain("prompt");
    expect(h.state.calls.some((c) => c.method === "queue.enqueue")).toBe(false);
  });

  it("a fired steer leaves an ephemeral, marked user item (US5-1)", async () => {
    h.state.methods.set("queue.enqueue", () => ({ ok: true, id: "q-2" }));
    usePiStore.setState({ isStreaming: true });

    await usePiStore.getState().sendImages("interrupt!", [], "steer");

    const items = usePiStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].ephemeral).toBe(true);
    expect(items[0].steer).toBe(true);
  });

  it("queue.get restores the full snapshot into the store (FR-001)", async () => {
    h.state.methods.set("queue.get", () => ({
      items: [
        {
          id: "q-9",
          mode: "followUp",
          text: "restored",
          images: [{ data: "abc", mimeType: "image/png" }],
          status: "queued",
          createdAt: 1,
        },
      ],
      paused: true,
      pauseReason: "aborted",
      drift: false,
    }));

    await usePiStore.getState().refreshQueue();

    const queue = usePiStore.getState().queue;
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].id).toBe("q-9");
    expect(queue.items[0].images).toHaveLength(1);
    expect(queue.paused).toBe(true);
    expect(queue.pauseReason).toBe("aborted");
    expect(queue.drift).toBe(false);
  });

  it("replayMessages drops ephemeral items — the transcript wins (plan 5)", async () => {
    h.state.rpc.set("get_messages", () => ({
      messages: [{ role: "user", content: "real recorded message" }],
    }));
    usePiStore.setState({ items: [userItem("real recorded message")] });
    const ephemeral = userItem("steer fire trace");
    ephemeral.ephemeral = true;
    ephemeral.steer = true;
    usePiStore.setState({ items: [...usePiStore.getState().items, ephemeral] });

    await usePiStore.getState().replayMessages();

    const items = usePiStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items.every((i) => !i.ephemeral)).toBe(true);
  });

  it("queueRestore fills the composer in restore mode with the images (US3)", async () => {
    h.state.methods.set("queue.restore", () => ({
      ok: true,
      text: "take me back",
      images: [{ data: "abc", mimeType: "image/png" }],
    }));

    const ok = await usePiStore.getState().queueRestore("q-3");

    expect(ok).toBe(true);
    const prompt = usePiStore.getState().pendingPrompt;
    expect(prompt?.mode).toBe("restore");
    expect(prompt?.text).toBe("take me back");
    expect(prompt?.images).toHaveLength(1);
  });

  it("a session change with queued entries asks first and only proceeds on confirm (FR-012)", async () => {
    usePiStore.setState({
      queue: {
        items: [
          { id: "q-1", mode: "followUp", text: "t", images: [], status: "queued", createdAt: 1 },
        ],
        paused: false,
        pauseReason: null,
        drift: false,
      },
    });

    await usePiStore.getState().newSession();
    expect(usePiStore.getState().queueDiscardConfirm).toMatchObject({ count: 1, kind: "new" });
    expect(commandTypes()).not.toContain("new_session");

    await usePiStore.getState().confirmQueueDiscard(false);
    expect(usePiStore.getState().queueDiscardConfirm).toBeNull();
    expect(commandTypes()).not.toContain("new_session");

    await usePiStore.getState().newSession();
    await usePiStore.getState().confirmQueueDiscard(true);
    expect(h.state.calls.some((c) => c.method === "queue.clear")).toBe(true);
    expect(commandTypes()).toContain("new_session");
  });
});

describe("session navigation state (spec 006)", () => {
  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    h.state.rpc.set("get_messages", () => ({ messages: [] }));
    h.state.rpc.set("get_state", () => ({ sessionId: "s-2" }));
    h.state.rpc.set("switch_session", () => ({}));
  });

  it("switchSession resets the outline and search state (FR-015)", async () => {
    usePiStore.setState({
      outlineOpen: true,
      search: { open: true, query: "timeout", index: 2 },
      pendingSearchJump: { query: "timeout", hitIndex: 2 },
    });

    await usePiStore.getState().switchSession("other-session.jsonl");

    const s = usePiStore.getState();
    expect(s.outlineOpen).toBe(false);
    expect(s.search).toEqual({ open: false, query: "", index: 0 });
    expect(s.pendingSearchJump).toBeNull();
    expect(command("switch_session")[0]["sessionPath"]).toBe("other-session.jsonl");
  });

  it("searchGo wraps around both ends of the hit list", () => {
    // Hits derive from the transcript; two messages containing "timeout".
    usePiStore.setState({
      items: [userItem("timeout one"), assistantItem("a timeout and another timeout")],
      search: { open: true, query: "timeout", index: 0 },
    });
    const { searchGo, searchHits } = usePiStore.getState();
    expect(searchHits()).toHaveLength(3);

    searchGo(-1);
    expect(usePiStore.getState().search.index).toBe(2); // wrap backwards
    searchGo(1);
    expect(usePiStore.getState().search.index).toBe(0); // wrap forwards
    searchGo(2);
    expect(usePiStore.getState().search.index).toBe(2);
  });

  it("searchGo is a no-op without hits", () => {
    usePiStore.setState({ items: [], search: { open: true, query: "nothing", index: 0 } });
    usePiStore.getState().searchGo(1);
    expect(usePiStore.getState().search.index).toBe(0);
  });

  it("setSearchIndex clamps into the hit range", () => {
    usePiStore.setState({
      items: [userItem("timeout one"), assistantItem("a timeout")],
      search: { open: true, query: "timeout", index: 0 },
    });
    usePiStore.getState().setSearchIndex(99);
    expect(usePiStore.getState().search.index).toBe(1);
  });

  it("toggleOutline flips and pins the outline state", () => {
    usePiStore.setState({ outlineOpen: false });
    usePiStore.getState().toggleOutline();
    expect(usePiStore.getState().outlineOpen).toBe(true);
    usePiStore.getState().toggleOutline(true);
    expect(usePiStore.getState().outlineOpen).toBe(true);
    usePiStore.getState().toggleOutline(false);
    expect(usePiStore.getState().outlineOpen).toBe(false);
  });
});

// -- Session titles (012 US1, T105/T106/T109) --------------------------------

describe("session titles (012 US1)", () => {
  const currentRow = {
    file: "/tmp/sess-a.jsonl",
    id: "sess-A",
    timestamp: "2026-11-07T00:00:00Z",
    name: "",
    preview: "",
    modifiedAt: 0,
  };

  const dispatchPi = (event: Record<string, unknown>) =>
    h.state.piHandler?.("pi", event);

  beforeEach(() => {
    h.state.calls.length = 0;
    h.state.rpc.set("get_state", () => ({ sessionId: "sess-A" }));
    h.state.rpc.set("set_session_name", (cmd) => {
      if (!cmd["name"]) throw new Error("Session name cannot be empty");
      return { success: true };
    });
    h.state.methods.set("sessions.list", () => ({ sessions: [{ ...currentRow }] }));
    usePiStore.setState({
      sessionId: "sess-A",
      sessionName: undefined,
      manualTitle: false,
      autoTitled: false,
      llmTitled: false,
      editingSessionTitle: null,
      sessions: [{ ...currentRow }],
      items: [],
    });
  });

  it("a name event updates the status bar and the matching list row with zero refreshes (T105)", async () => {
    await usePiStore.getState().init();
    h.state.calls.length = 0;

    dispatchPi({ type: "session_info_changed", name: "Auto title" });

    expect(usePiStore.getState().sessionName).toBe("Auto title");
    expect(usePiStore.getState().sessions.find((s) => s.id === "sess-A")?.name).toBe("Auto title");
    expect(h.state.calls.filter((c) => c.method === "sessions.list")).toHaveLength(0);
  });

  it("a hand-set title wins over a later pi event (T106)", async () => {
    await usePiStore.getState().init();
    usePiStore.setState({ manualTitle: true, sessionName: "手动名", sessions: [{ ...currentRow, name: "手动名" }] });

    dispatchPi({ type: "session_info_changed", name: "auto name" });

    expect(usePiStore.getState().sessionName).toBe("手动名");
    expect(usePiStore.getState().sessions[0].name).toBe("手动名");
  });

  it("a late event never writes into a session the user switched away from (T106)", async () => {
    await usePiStore.getState().init();
    usePiStore.setState({
      sessionId: "sess-B",
      sessions: [{ ...currentRow }, { ...currentRow, id: "sess-B", file: "/tmp/sess-b.jsonl" }],
    });

    dispatchPi({ type: "session_info_changed", name: "late name" });

    // the status bar follows pi (it tracks the *event*), but only sess-B rows
    // would be updated — sess-A stays as it was
    expect(usePiStore.getState().sessions.find((s) => s.id === "sess-A")?.name).toBe("");
  });

  it("an event after the session was deleted does not throw (T106)", async () => {
    await usePiStore.getState().init();
    usePiStore.setState({ sessions: [] });
    expect(() => dispatchPi({ type: "session_info_changed", name: "ghost" })).not.toThrow();
  });

  it("the first user message names the session via set_session_name — nothing else (T109)", async () => {
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({ items: [userItem("fix the login bug")] });

    dispatchPi({ type: "message_end", message: { role: "user", content: "fix the login bug" } });
    await vi.waitFor(() => expect(commandTypes()).toContain("set_session_name"));

    expect(command("set_session_name")[0]["name"]).toBe("fix the login bug");
    // no model call is ever made for titling
    expect(commandTypes()).not.toContain("prompt");
    expect(usePiStore.getState().autoTitled).toBe(true);
  });

  it("titling fires exactly once even when more messages arrive (T109)", async () => {
    await usePiStore.getState().init();
    usePiStore.setState({ items: [userItem("first")] });
    dispatchPi({ type: "message_end", message: { role: "user", content: "first" } });
    await vi.waitFor(() => expect(commandTypes()).toContain("set_session_name"));

    h.state.calls.length = 0;
    usePiStore.setState({ items: [userItem("first"), userItem("second")] });
    dispatchPi({ type: "message_end", message: { role: "user", content: "second" } });
    await new Promise((r) => setTimeout(r, 20));

    expect(commandTypes()).not.toContain("set_session_name");
  });

  it("an expanded skill message titles with the user question, not the body (T109 + 011)", async () => {
    await usePiStore.getState().init();
    const expanded =
      '<skill name="demo" location="/tmp/x/SKILL.md">\nLONG BODY MARKER\n</skill>\n\nwhat does it do?';
    usePiStore.setState({ items: [userItem(expanded)] });

    dispatchPi({ type: "message_end", message: { role: "user", content: expanded } });
    await vi.waitFor(() => expect(commandTypes()).toContain("set_session_name"));

    expect(command("set_session_name")[0]["name"]).toBe("what does it do?");
  });

  it("a pure-image first message produces no title attempt", async () => {
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    const image = emptyItem("user", [{ kind: "image", data: "AA", mimeType: "image/png" }]);
    image.done = true;
    usePiStore.setState({ items: [image] });

    dispatchPi({ type: "message_end", message: { role: "user", content: [] } });
    await new Promise((r) => setTimeout(r, 20));

    expect(commandTypes()).not.toContain("set_session_name");
    expect(usePiStore.getState().autoTitled).toBe(true);
  });

  it("submitSessionTitle validates: empty and overlong are refused, the editor stays open", async () => {
    await usePiStore.getState().init();
    usePiStore.setState({ editingSessionTitle: "current" });

    expect(await usePiStore.getState().submitSessionTitle("   ")).toBe("empty");
    expect(await usePiStore.getState().submitSessionTitle("中".repeat(33))).toBe("long");
    expect(usePiStore.getState().editingSessionTitle).toBe("current");
    expect(commandTypes()).not.toContain("set_session_name");

    expect(await usePiStore.getState().submitSessionTitle("  real name  ")).toBe("ok");
    expect(command("set_session_name")[0]["name"]).toBe("real name");
    expect(usePiStore.getState().editingSessionTitle).toBe(null);
    // a hand rename marks the session so pi events cannot rename it back
    expect(usePiStore.getState().manualTitle).toBe(true);
  });

  it("renaming another session's row goes through sessions.rename, not pi (012 T107)", async () => {
    const otherRow = { ...currentRow, file: "/tmp/sess-b.jsonl", id: "sess-B", name: "" };
    h.state.methods.set("sessions.list", () => ({ sessions: [{ ...currentRow }, { ...otherRow }] }));
    h.state.methods.set("sessions.rename", (params) => {
      // The real bridge appends a session_info entry; the row follows on refresh.
      const p = params as { file?: string; name?: string };
      otherRow.name = p.name ?? "";
      return { ok: true };
    });
    await usePiStore.getState().init();
    usePiStore.setState({ sessions: [{ ...currentRow }, { ...otherRow }], editingSessionTitle: "/tmp/sess-b.jsonl" });
    h.state.calls.length = 0;

    expect(await usePiStore.getState().submitSessionTitle("old friend")).toBe("ok");

    // The offline row never touches the live session's RPC.
    expect(commandTypes()).not.toContain("set_session_name");
    const rename = h.state.calls.find((c) => c.method === "sessions.rename");
    expect(rename?.params).toEqual({ file: "/tmp/sess-b.jsonl", name: "old friend" });
    // The list refresh picks the new name up; the live session is not flagged.
    expect(usePiStore.getState().sessions.find((s) => s.id === "sess-B")?.name).toBe("old friend");
    expect(usePiStore.getState().editingSessionTitle).toBe(null);
    expect(usePiStore.getState().manualTitle).toBe(false);
  });

  it("renaming the current row (its file) still goes through pi's set_session_name", async () => {
    await usePiStore.getState().init();
    usePiStore.setState({ editingSessionTitle: "/tmp/sess-a.jsonl" });
    h.state.calls.length = 0;

    expect(await usePiStore.getState().submitSessionTitle("live one")).toBe("ok");

    expect(command("set_session_name")[0]["name"]).toBe("live one");
    expect(h.state.calls.some((c) => c.method === "sessions.rename")).toBe(false);
  });

  // -- stage B: the LLM refinement fired after the first assistant reply ----

  it("B: the first assistant reply refines the title through title.generate", async () => {
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({
      items: [userItem("帮我修复登录 bug")],
      model: { id: "openrouter/free", provider: "openrouter" },
    });
    h.state.methods.set("title.generate", () => ({ title: "修复登录 bug" }));

    // applyEvent replaces the assistant item from the event's content — the
    // event must carry the text itself, exactly like the real pi event.
    dispatchPi({ type: "message_end", message: { role: "assistant", content: "我来看下 auth.ts" } });

    await vi.waitFor(() => expect(h.state.calls.some((c) => c.method === "title.generate")).toBe(true));
    const gen = h.state.calls.find((c) => c.method === "title.generate")!;
    expect(gen.params["provider"]).toBe("openrouter");
    expect(gen.params["modelId"]).toBe("openrouter/free");
    expect(String(gen.params["user"])).toContain("登录");
    expect(String(gen.params["assistant"])).toContain("auth.ts");
    // the refinement lands through the same write-back as A
    await vi.waitFor(() =>
      expect(command("set_session_name").some((c) => c["name"] === "修复登录 bug")).toBe(true),
    );
    expect(usePiStore.getState().llmTitled).toBe(true);
  });

  it("B: fires only with text on both sides — an empty reply retries on the next one", async () => {
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({ items: [userItem("question")] });

    dispatchPi({ type: "message_end", message: { role: "assistant", content: [] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.state.calls.some((c) => c.method === "title.generate")).toBe(false);
    expect(usePiStore.getState().llmTitled).toBe(false);

    usePiStore.setState({ items: [userItem("question")] });
    dispatchPi({ type: "message_end", message: { role: "assistant", content: "answer" } });
    await vi.waitFor(() => expect(h.state.calls.some((c) => c.method === "title.generate")).toBe(true));
  });

  it("B: failure keeps A's title and never surfaces", async () => {
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({ items: [userItem("q")] });
    h.state.methods.set("title.generate", () => Promise.reject(new Error("pi one-shot failed")));

    dispatchPi({ type: "message_end", message: { role: "assistant", content: "a" } });

    await vi.waitFor(() => expect(h.state.calls.some((c) => c.method === "title.generate")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(commandTypes()).not.toContain("set_session_name");
  });

  it("B: never fires when the title was set by hand", async () => {
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({ manualTitle: true, items: [userItem("q")] });

    dispatchPi({ type: "message_end", message: { role: "assistant", content: "a" } });

    await new Promise((r) => setTimeout(r, 20));
    expect(h.state.calls.some((c) => c.method === "title.generate")).toBe(false);
    expect(usePiStore.getState().llmTitled).toBe(false);
  });

  it("B: a session the user switched away from is renamed through the file append", async () => {
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({
      items: [userItem("fix the login bug")],
      sessions: [{ ...currentRow, name: "fix the login bug" }, { ...currentRow, id: "sess-B", file: "/tmp/sess-b.jsonl" }],
    });
    let resolveGen: (v: unknown) => void = () => undefined;
    h.state.methods.set("title.generate", () => new Promise((r) => (resolveGen = r)));

    dispatchPi({ type: "message_end", message: { role: "assistant", content: "on it" } });
    await vi.waitFor(() => expect(h.state.calls.some((c) => c.method === "title.generate")).toBe(true));

    // the user moves on before the one-shot answers
    usePiStore.setState({ sessionId: "sess-B" });
    resolveGen({ title: "Login bug hunt" });

    await vi.waitFor(() => expect(h.state.calls.some((c) => c.method === "sessions.rename")).toBe(true));
    const rename = h.state.calls.find((c) => c.method === "sessions.rename")!;
    expect(rename.params).toEqual({ file: "/tmp/sess-a.jsonl", name: "Login bug hunt" });
    // the live session (sess-B) is never touched
    expect(commandTypes()).not.toContain("set_session_name");
  });

  it("B: a row renamed while generating is left alone", async () => {
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({
      items: [userItem("fix the login bug")],
      sessions: [{ ...currentRow, name: "fix the login bug" }, { ...currentRow, id: "sess-B", file: "/tmp/sess-b.jsonl" }],
    });
    let resolveGen: (v: unknown) => void = () => undefined;
    h.state.methods.set("title.generate", () => new Promise((r) => (resolveGen = r)));
    dispatchPi({ type: "message_end", message: { role: "assistant", content: "on it" } });
    await vi.waitFor(() => expect(h.state.calls.some((c) => c.method === "title.generate")).toBe(true));

    usePiStore.setState({
      sessionId: "sess-B",
      sessions: [{ ...currentRow, name: "手动新名" }, { ...currentRow, id: "sess-B", file: "/tmp/sess-b.jsonl" }],
    });
    resolveGen({ title: "Login bug hunt" });
    await new Promise((r) => setTimeout(r, 20));

    expect(h.state.calls.some((c) => c.method === "sessions.rename")).toBe(false);
  });
});

describe("auth login reduction (spec 014)", () => {
  /** Dispatch one `auth` bridge event through the wired handler. */
  const auth = (data: Record<string, unknown>) => h.state.piHandler?.("auth", data);

  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    await usePiStore.getState().init();
    usePiStore.getState().resetAuthLogin();
  });

  it("started resets a previous run's tail (US4: no mixed attempts)", () => {
    auth({ kind: "started", provider: "a" });
    auth({ kind: "event", ev: { type: "progress", message: "old" } });
    auth({ kind: "prompt", id: 1, p: { type: "text", message: "old" } });
    auth({ kind: "started", provider: "b" });
    const s = usePiStore.getState().authLogin;
    expect(s.phase).toBe("running");
    expect(s.provider).toBe("b");
    expect(s.events).toHaveLength(0);
    expect(s.prompt).toBeNull();
    expect(s.done).toBeNull();
  });

  it("event/prompt/done flow carries the fields the panel renders", () => {
    auth({ kind: "started", provider: "openrouter" });
    auth({
      kind: "event",
      browserOpened: true,
      ev: { type: "auth_url", url: "https://x/auth", instructions: "Sign in" },
    });
    auth({ kind: "prompt", id: 3, p: { type: "manual_code", message: "Paste the URL" } });
    auth({ kind: "done", ok: true });
    const s = usePiStore.getState().authLogin;
    expect(s.phase).toBe("done");
    expect(s.browserOpened).toBe(true);
    expect(s.events[0]).toMatchObject({ type: "auth_url", url: "https://x/auth" });
    expect(s.prompt).toBeNull();
    expect(s.done).toEqual({ ok: true, cancelled: undefined, error: undefined });
  });

  it("failure keeps pi's error text and cancellation is visible", () => {
    auth({ kind: "started", provider: "openrouter" });
    auth({ kind: "done", ok: false, cancelled: true, error: "login cancelled" });
    const s = usePiStore.getState().authLogin;
    expect(s.phase).toBe("done");
    expect(s.done).toEqual({ ok: false, cancelled: true, error: "login cancelled" });
  });

  it("event stream is capped (chatty provider cannot grow unbounded)", () => {
    auth({ kind: "started", provider: "p" });
    for (let i = 0; i < 15; i++) auth({ kind: "event", ev: { type: "progress", message: `step ${i}` } });
    expect(usePiStore.getState().authLogin.events).toHaveLength(10);
    expect(usePiStore.getState().authLogin.events.at(-1)).toMatchObject({ message: "step 14" });
  });
});

describe("model catalog reload (spec 017)", () => {
  beforeEach(() => {
    h.state.calls.length = 0;
    h.state.methods.clear();
    h.state.rpc.clear();
  });

  it("replaces the list with what the bridge returns", async () => {
    usePiStore.setState({ models: [{ provider: "old", id: "old-1" }] });
    h.state.methods.set("models.reload", () => ({
      models: [{ provider: "fresh", id: "fresh-1", name: "Fresh One" }],
      refreshed: true,
    }));

    const refreshed = await usePiStore.getState().reloadModels();

    expect(refreshed).toBe(true);
    expect(usePiStore.getState().models.map((m) => m.id)).toEqual(["fresh-1"]);
    expect(usePiStore.getState().sources.models.status).toBe("ready");
    expect(h.state.calls.map((c) => c.method)).toContain("models.reload");
  });

  it("keeps the list when the in-process refresh was unavailable", async () => {
    h.state.methods.set("models.reload", () => ({
      models: [{ provider: "p", id: "p-1" }],
      refreshed: false,
    }));

    const refreshed = await usePiStore.getState().reloadModels();

    expect(refreshed).toBe(false);
    expect(usePiStore.getState().models).toHaveLength(1);
    expect(usePiStore.getState().sources.models.status).toBe("ready");
  });

  it("surfaces a failed reload through the models source", async () => {
    h.state.methods.set("models.reload", () => {
      throw new Error("pi process is not running");
    });

    const refreshed = await usePiStore.getState().reloadModels();

    expect(refreshed).toBe(false);
    expect(usePiStore.getState().sources.models.status).toBe("failed");
    expect(usePiStore.getState().sources.models.error).toContain("not running");
  });

  it("keeps the plugin's own extension command out of slash completion", async () => {
    h.state.rpc.set("get_commands", () => ({
      commands: [
        { name: "fix-tests", description: "Fix tests", source: "prompt" },
        { name: "pi-agent-reload-models", description: "internal", source: "extension" },
      ],
    }));

    await usePiStore.getState().refreshCommands();

    expect(usePiStore.getState().commands.map((c) => c.name)).toEqual(["fix-tests"]);
  });
});

/**
 * The toolbar's 搜索 button is a toggle. Real machine: it only ever called
 * openSearch(), so a second click did nothing and the × was the only way out.
 */
describe("session search bar toggle", () => {
  beforeEach(() => {
    usePiStore.setState({ search: { open: false, query: "", index: 0 } });
  });

  it("opens on the first click and closes on the second", () => {
    usePiStore.getState().toggleSearch();
    expect(usePiStore.getState().search.open).toBe(true);

    usePiStore.getState().toggleSearch();
    expect(usePiStore.getState().search.open).toBe(false);
  });

  it("clears the query when the toggle closes the bar", () => {
    usePiStore.getState().openSearch();
    usePiStore.getState().setSearchQuery("needle");

    usePiStore.getState().toggleSearch();

    const { search } = usePiStore.getState();
    expect(search.open).toBe(false);
    expect(search.query).toBe("");
  });

  it("leaves Ctrl/Cmd+F opening an already-open bar untouched", () => {
    usePiStore.getState().openSearch();
    usePiStore.getState().setSearchQuery("needle");

    usePiStore.getState().openSearch();

    const { search } = usePiStore.getState();
    expect(search.open).toBe(true);
    expect(search.query).toBe("needle");
  });
});

// -- 021: optimistic session switch / new session -----------------------------

describe("session switching (021)", () => {
  /** A promise the test resolves by hand — models a slow pi RPC. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

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
      pendingSwitch: null,
      tab: "chat",
      sessionName: undefined,
      stats: undefined,
    });
  });

  it("starts with no pending switch and clears it after a new session lands", async () => {
    expect(usePiStore.getState().pendingSwitch).toBeNull();

    const gate = deferred<unknown>();
    h.state.rpc.set("new_session", () => gate.promise);

    const done = usePiStore.getState().newSession();
    // Click → placeholder state, *before* pi answers.
    expect(usePiStore.getState().pendingSwitch?.kind).toBe("new");
    expect(usePiStore.getState().items).toEqual([]);

    gate.resolve({});
    await done;
    expect(usePiStore.getState().pendingSwitch).toBeNull();
  });

  it("clears the transcript before the new_session RPC resolves, and restores it on failure", async () => {
    const old = [userItem("keep me")];
    usePiStore.setState({ items: old });

    const gate = deferred<unknown>();
    h.state.rpc.set("new_session", () => gate.promise);

    // Content present → the store asks first; the snapshot is only taken once
    // the user confirms, which is exactly what the dialog's handler does.
    expect(usePiStore.getState().newSession()).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(usePiStore.getState().confirm).not.toBeNull());
    const confirmed = usePiStore.getState().confirm!.onConfirm();
    expect(usePiStore.getState().items).toEqual([]);

    gate.reject(new Error("pi exploded"));
    await confirmed;

    // The snapshot comes back, and the failure is visible as an error item
    // appended after it (silently restoring would hide pi's refusal).
    const restored = usePiStore.getState().items;
    expect(restored[0].id).toBe(old[0].id);
    expect(restored.some((i) => i.isError)).toBe(true);
    expect(usePiStore.getState().pendingSwitch).toBeNull();
  });

  it("switches the visible tab to chat before switch_session resolves", async () => {
    usePiStore.setState({ tab: "sessions" });
    const gate = deferred<unknown>();
    h.state.rpc.set("switch_session", () => gate.promise);
    h.state.rpc.set("get_messages", () => ({ messages: [] }));
    h.state.rpc.set("get_session_stats", () => ({ messages: 0 }));
    h.state.rpc.set("get_state", () => ({ sessionName: "target" }));

    const done = usePiStore.getState().switchSession("/sessions/target.jsonl");
    expect(usePiStore.getState().tab).toBe("chat");
    expect(usePiStore.getState().pendingSwitch).toMatchObject({ kind: "history", file: "/sessions/target.jsonl" });

    gate.resolve({});
    await done;
    expect(usePiStore.getState().pendingSwitch).toBeNull();
  });

  it("aborts a running stream only after the view already switched", async () => {
    const order: string[] = [];
    usePiStore.setState({ isStreaming: true });
    h.state.rpc.set("abort", () => {
      order.push(`abort@${usePiStore.getState().tab}`);
      return {};
    });
    h.state.rpc.set("switch_session", () => ({}));
    h.state.rpc.set("get_messages", () => ({ messages: [] }));
    h.state.rpc.set("get_session_stats", () => ({}));
    h.state.rpc.set("get_state", () => ({}));

    await usePiStore.getState().switchSession("/sessions/t.jsonl");

    expect(order).toEqual(["abort@chat"]);
  });

  it("reads messages, stats and state in parallel and applies them in one set", async () => {
    const gates = {
      get_messages: deferred<unknown>(),
      get_session_stats: deferred<unknown>(),
      get_state: deferred<unknown>(),
    };
    h.state.rpc.set("switch_session", () => ({}));
    for (const [type, gate] of Object.entries(gates)) h.state.rpc.set(type, () => gate.promise);

    const snapshots: Array<{ items: number; name: string | undefined }> = [];
    const unsub = usePiStore.subscribe((s) => snapshots.push({ items: s.items.length, name: s.sessionName }));

    const done = usePiStore.getState().switchSession("/sessions/t.jsonl");
    // All three reads are in flight before any of them answers — sequential
    // awaits would leave get_session_stats/get_state unrequested here.
    await vi.waitFor(() =>
      expect(commandTypes()).toEqual(expect.arrayContaining(["get_messages", "get_session_stats", "get_state"])),
    );

    gates.get_messages.resolve({ messages: [{ role: "user", content: "hello" }] });
    gates.get_session_stats.resolve({ messages: 1 });
    gates.get_state.resolve({ sessionName: "Target session" });
    await done;
    unsub();

    const state = usePiStore.getState();
    expect(state.items).toHaveLength(1);
    expect(state.sessionName).toBe("Target session");
    // No frame had content without its title (that would flash the old name).
    expect(snapshots.some((s) => s.items > 0 && s.name !== "Target session")).toBe(false);
  });

  it("drops a late response when a newer switch already owns the screen", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let call = 0;
    h.state.rpc.set("switch_session", () => (++call === 1 ? first.promise : second.promise));
    h.state.rpc.set("get_messages", () => ({ messages: [{ role: "user", content: "from target" }] }));
    h.state.rpc.set("get_session_stats", () => ({}));
    h.state.rpc.set("get_state", () => ({ sessionName: "B" }));

    const pa = usePiStore.getState().switchSession("/sessions/a.jsonl");
    const pb = usePiStore.getState().switchSession("/sessions/b.jsonl");
    // The late A response must not paint over B.
    first.resolve({});
    await pa;
    expect(usePiStore.getState().pendingSwitch).toMatchObject({ file: "/sessions/b.jsonl" });
    second.resolve({});
    await pb;
    expect(usePiStore.getState().pendingSwitch).toBeNull();
    expect(usePiStore.getState().sessionName).toBe("B");
  });

  it("returns to the session list when the switch fails", async () => {
    h.state.rpc.set("switch_session", () => {
      throw new Error("no such session");
    });

    await usePiStore.getState().switchSession("/sessions/gone.jsonl");

    expect(usePiStore.getState().tab).toBe("sessions");
    expect(usePiStore.getState().pendingSwitch).toBeNull();
    expect(usePiStore.getState().items.some((i) => i.isError)).toBe(true);
  });

  it("ignores a second new-session request while one is in flight", async () => {
    const gate = deferred<unknown>();
    let calls = 0;
    h.state.rpc.set("new_session", () => {
      calls += 1;
      return gate.promise;
    });

    const first = usePiStore.getState().newSession();
    void usePiStore.getState().newSession();
    gate.resolve({});
    await first;

    expect(calls).toBe(1);
  });

  it("softens the copy after ten seconds without rolling anything back", () => {
    const started = 1_000;
    expect(isSwitchLong(started, started + 9_999)).toBe(false);
    expect(isSwitchLong(started, started + 10_000)).toBe(true);
  });
});
