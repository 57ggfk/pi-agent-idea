import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Status panel data layer (specs/20261128-092912-status-panel plan §数据层):
 * D1 setStatus entries · D2 subagent-async widget feed · D4 todo snapshot ·
 * D5 output derivation.
 *
 * Pure-function halves run against plain fixtures; store halves drive the real
 * store through a recording bridge (same harness as store.test.ts).
 *
 * Wire shapes verified against the local pi 1.6.1 package
 * (dist/modes/rpc/rpc-mode.js:106-115 setStatus, dist/core/tools/*.d.ts
 * write/edit schemas) and probe-036 (specs/.../probe.md §4/§5). The todo
 * parser is a mock-only tolerance layer (plan D4: no todo extension is
 * installed on this machine — shapes grow when the real machine meets one).
 */

type Call = { method: string; params: Record<string, unknown>; at: number };

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
vi.mock("../lib/clipboard", () => ({
  copyText: () => Promise.resolve(true),
}));

import {
  usePiStore,
  resetSwitchGate,
  resetSubagentThrottle,
  SUBAGENT_FLUSH_MS,
} from "./store";
import {
  EXTENSION_STATUS_CAP,
  WRITE_TOOLS,
  emptyItem,
  jobStepChain,
  mapJobState,
  outputEditsFromItems,
  parseSubagentAsyncWidget,
  resetItemIds,
  todoSnapshotFromItems,
  upsertExtensionStatus,
  type AsyncStatusSnapshot,
  type ChatItem,
} from "./types";

// -- fixtures ----------------------------------------------------------------

/** A pi-subagents async snapshot in the probe-036 §5 shape. */
const snapshotOf = (runs: unknown[], overrides: Record<string, unknown> = {}) => ({
  kind: "pi-subagents.async-status-snapshot",
  version: 1,
  generatedAt: "2026-11-28T04:10:00.000Z",
  caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 2, maxStringLength: 4000, maxSerializedBytes: 65536 },
  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
  runs,
  ...overrides,
});

const asFrameLines = (snap: unknown): string[] => ["PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(snap)];

let tcSeq = 0;
/** An assistant item carrying one toolcall block; `args` may be an object or a raw (broken) string. */
const itemWithTool = (toolName: string, args: unknown, opts: { done?: boolean } = {}): ChatItem => {
  const item = emptyItem("assistant", [
    {
      kind: "toolcall",
      id: `tc-${++tcSeq}`,
      toolName,
      argsJson: typeof args === "string" ? args : JSON.stringify(args),
      done: opts.done ?? true,
    },
  ]);
  item.done = true;
  return item;
};

// -- a) setStatus entries (D1) ------------------------------------------------

describe("upsertExtensionStatus (D1 pure)", () => {
  const entry = (statusKey: string, text: string, updatedAt: number) => ({ statusKey, text, updatedAt });

  it("inserts a new key at the end", () => {
    expect(upsertExtensionStatus([], "tokens", "12k", 100)).toEqual([entry("tokens", "12k", 100)]);
  });

  it("same key overwrites in place — insertion order is stable", () => {
    let list = upsertExtensionStatus([], "a", "1", 100);
    list = upsertExtensionStatus(list, "b", "2", 200);
    list = upsertExtensionStatus(list, "a", "1-updated", 300);
    expect(list.map((x) => x.statusKey)).toEqual(["a", "b"]);
    expect(list[0]).toEqual(entry("a", "1-updated", 300));
  });

  it("a non-string statusText clears the entry by key (setStatus(key, undefined); JSON drops the undefined key)", () => {
    let list = upsertExtensionStatus([], "a", "1", 100);
    list = upsertExtensionStatus(list, "b", "2", 200);
    list = upsertExtensionStatus(list, "a", undefined, 300);
    expect(list.map((x) => x.statusKey)).toEqual(["b"]);
    // clearing an absent key is a no-op
    expect(upsertExtensionStatus(list, "ghost", undefined, 400)).toEqual(list);
    // null and other non-strings clear too (JSON 面无校验)
    expect(upsertExtensionStatus(list, "b", null, 400)).toEqual([]);
  });

  it("caps at EXTENSION_STATUS_CAP entries, evicting the oldest updatedAt", () => {
    let list: ReturnType<typeof upsertExtensionStatus> = [];
    for (let i = 0; i <= EXTENSION_STATUS_CAP; i++) {
      list = upsertExtensionStatus(list, `k${i}`, `t${i}`, i * 1000);
    }
    expect(EXTENSION_STATUS_CAP).toBe(12); // plan D1 D-推荐值
    expect(list).toHaveLength(EXTENSION_STATUS_CAP);
    expect(list[0]).toEqual(entry("k1", "t1", 1000));
    expect(list.at(-1)).toEqual(entry(`k${EXTENSION_STATUS_CAP}`, `t${EXTENSION_STATUS_CAP}`, EXTENSION_STATUS_CAP * 1000));
  });

  it("cap eviction on a same-ms burst falls back to FIFO (earliest insertion)", () => {
    let list: ReturnType<typeof upsertExtensionStatus> = [];
    for (let i = 0; i <= EXTENSION_STATUS_CAP; i++) {
      list = upsertExtensionStatus(list, `k${i}`, `t${i}`, 1000);
    }
    expect(list.map((x) => x.statusKey)).toEqual(
      Array.from({ length: EXTENSION_STATUS_CAP }, (_, i) => `k${i + 1}`),
    );
  });
});

describe("store: setStatus entries land instead of being dropped (D1)", () => {
  const dispatchPi = (data: Record<string, unknown>) => h.state.piHandler?.("pi", data);

  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    resetSwitchGate();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({
      piStatus: "running",
      extensionStatuses: [],
      approvals: [],
      items: [],
    });
  });

  it("setStatus reaches extensionStatuses (FR-003; the old branch dropped it)", () => {
    dispatchPi({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "tokens", statusText: "12.0k" });
    const list = usePiStore.getState().extensionStatuses;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ statusKey: "tokens", text: "12.0k" });
    expect(typeof list[0].updatedAt).toBe("number");
  });

  it("same key overwrites in place, new keys append (插入序稳定)", () => {
    dispatchPi({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "a", statusText: "1" });
    dispatchPi({ type: "extension_ui_request", id: "2", method: "setStatus", statusKey: "b", statusText: "2" });
    dispatchPi({ type: "extension_ui_request", id: "3", method: "setStatus", statusKey: "a", statusText: "1!" });
    expect(usePiStore.getState().extensionStatuses.map((x) => [x.statusKey, x.text])).toEqual([
      ["a", "1!"],
      ["b", "2"],
    ]);
  });

  it("missing statusText clears the entry (setStatus(key, undefined))", () => {
    dispatchPi({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "a", statusText: "1" });
    dispatchPi({ type: "extension_ui_request", id: "2", method: "setStatus", statusKey: "a" });
    expect(usePiStore.getState().extensionStatuses).toEqual([]);
  });

  it("caps the mirror at 12 entries (defensive against chatty extensions)", () => {
    for (let i = 0; i < 13; i++) {
      dispatchPi({
        type: "extension_ui_request",
        id: String(i),
        method: "setStatus",
        statusKey: `k${i}`,
        statusText: `t${i}`,
      });
    }
    const list = usePiStore.getState().extensionStatuses;
    expect(list).toHaveLength(EXTENSION_STATUS_CAP);
    expect(list[0].statusKey).toBe("k1"); // oldest evicted
    expect(list.at(-1)!.statusKey).toBe("k12");
  });

  it("approval dialogs still queue, notify still dropped — the branches stay independent (D-4)", () => {
    dispatchPi({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Allow?", message: "run x" });
    dispatchPi({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" });
    dispatchPi({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "st", statusText: "busy" });
    expect(usePiStore.getState().approvals.map((a) => a.id)).toEqual(["d1"]);
    expect(usePiStore.getState().extensionStatuses.map((x) => x.statusKey)).toEqual(["st"]);
  });

  it("entries belong to the pi process: leaving running (exited / starting) clears them, running keeps them", () => {
    dispatchPi({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "a", statusText: "1" });
    h.state.piHandler?.("pi-state", { status: "running" });
    expect(usePiStore.getState().extensionStatuses).toHaveLength(1);
    h.state.piHandler?.("pi-state", { status: "exited" });
    expect(usePiStore.getState().extensionStatuses).toEqual([]);
    dispatchPi({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "a", statusText: "1" });
    h.state.piHandler?.("pi-state", { status: "starting" });
    expect(usePiStore.getState().extensionStatuses).toEqual([]);
  });
});

// -- b) todo snapshot (D4, mock-only shapes) ----------------------------------

describe("todoSnapshotFromItems (D4, mock-only tolerance layer)", () => {
  it("takes the latest todo toolcall as the snapshot — latest wins (整体替换)", () => {
    const items = [
      itemWithTool("todo_write", { items: [{ text: "old", status: "pending" }] }),
      itemWithTool("todowrite", {
        items: [
          { text: "one", status: "pending" },
          { text: "two", status: "in_progress" },
        ],
      }),
    ];
    expect(todoSnapshotFromItems(items)).toEqual([
      { text: "one", status: "pending" },
      { text: "two", status: "active" },
    ]);
  });

  it("matches any toolName containing todo, case-insensitively (TODO-Update)", () => {
    const items = [itemWithTool("TODO-Update", { todos: [{ content: "via content", status: "completed" }] })];
    expect(todoSnapshotFromItems(items)).toEqual([{ text: "via content", status: "done" }]);
  });

  it("maps the four input statuses; in_progress→active, completed→done, cancelled stays", () => {
    const entryWith = (status: unknown) => [itemWithTool("todo", { items: [{ text: "t", status }] })];
    expect(todoSnapshotFromItems(entryWith("pending"))).toEqual([{ text: "t", status: "pending" }]);
    expect(todoSnapshotFromItems(entryWith("in_progress"))).toEqual([{ text: "t", status: "active" }]);
    expect(todoSnapshotFromItems(entryWith("completed"))).toEqual([{ text: "t", status: "done" }]);
    expect(todoSnapshotFromItems(entryWith("cancelled"))).toEqual([{ text: "t", status: "cancelled" }]);
  });

  it("tolerates aliases and the boolean done (done→done / false→pending)", () => {
    const entryWith = (status: unknown) => [itemWithTool("todo", { items: [{ text: "t", status }] })];
    expect(todoSnapshotFromItems(entryWith("in-progress"))).toEqual([{ text: "t", status: "active" }]);
    expect(todoSnapshotFromItems(entryWith("done"))).toEqual([{ text: "t", status: "done" }]);
    expect(todoSnapshotFromItems(entryWith(true))).toEqual([{ text: "t", status: "done" }]);
    expect(todoSnapshotFromItems(entryWith(false))).toEqual([{ text: "t", status: "pending" }]);
  });

  it("unrecognized status strings fall back to pending (容错兼容层, no crash)", () => {
    const items = [itemWithTool("todo", { items: [{ text: "t", status: "mystery" }] })];
    expect(todoSnapshotFromItems(items)).toEqual([{ text: "t", status: "pending" }]);
  });

  it("field fallbacks: list items/todos/list, text text/content/label/title, status state/status/done", () => {
    expect(
      todoSnapshotFromItems([itemWithTool("todo_write", { list: [{ label: "L1", state: "active" }] })]),
    ).toEqual([{ text: "L1", status: "active" }]);
    expect(
      todoSnapshotFromItems([itemWithTool("todo_write", { todos: [{ title: "T1", done: true }] })]),
    ).toEqual([{ text: "T1", status: "done" }]);
    expect(
      todoSnapshotFromItems([itemWithTool("todo_write", { items: [{ content: "C1", status: "cancelled" }] })]),
    ).toEqual([{ text: "C1", status: "cancelled" }]);
  });

  it("skips streaming blocks (done:false) and unparseable args — the previous snapshot survives", () => {
    const good = itemWithTool("todo_write", { items: [{ text: "keep", status: "pending" }] });
    const streaming = itemWithTool("todo_write", { items: [{ text: "draft", status: "pending" }] }, { done: false });
    const broken = itemWithTool("todo_write", "{oops");
    expect(todoSnapshotFromItems([good, streaming, broken])).toEqual([{ text: "keep", status: "pending" }]);
  });

  it("entries without any text field drop out of the snapshot", () => {
    const items = [itemWithTool("todo", { items: [{ status: "done" }, { text: "kept", status: "pending" }] })];
    expect(todoSnapshotFromItems(items)).toEqual([{ text: "kept", status: "pending" }]);
  });

  it("no todo toolcall → null (FR-012: the section hides)", () => {
    expect(todoSnapshotFromItems([])).toBeNull();
    expect(todoSnapshotFromItems([itemWithTool("write", { path: "/x", content: "" })])).toBeNull();
    expect(todoSnapshotFromItems([itemWithTool("todo_write", "{broken")])).toBeNull();
  });
});

// -- c) output derivation (D5) -------------------------------------------------

describe("outputEditsFromItems (D5)", () => {
  beforeEach(() => resetItemIds());

  it("WRITE_TOOLS is pi's core write pair (dist/core/tools/index.d.ts:23 — no edit-diff exists)", () => {
    expect([...WRITE_TOOLS]).toEqual(["write", "edit"]);
  });

  it("collects write and edit calls from argsJson path", () => {
    const items = [
      itemWithTool("write", { path: "/proj/a.ts", content: "x" }),
      itemWithTool("edit", { path: "/proj/b.ts", edits: [{ oldText: "a", newText: "b" }] }),
    ];
    expect(outputEditsFromItems(items)).toEqual([
      { path: "/proj/a.ts", kinds: ["write"], count: 1, lastItemId: items[0].id },
      { path: "/proj/b.ts", kinds: ["edit"], count: 1, lastItemId: items[1].id },
    ]);
  });

  it("dedupes by path, merges kinds, counts calls; lastItemId follows the newest call", () => {
    const items = [
      itemWithTool("write", { path: "/proj/a.ts", content: "x" }),
      itemWithTool("edit", { path: "/proj/a.ts", edits: [{ oldText: "a", newText: "b" }] }),
      itemWithTool("write", { path: "/proj/a.ts", content: "y" }),
    ];
    expect(outputEditsFromItems(items)).toEqual([
      { path: "/proj/a.ts", kinds: ["write", "edit"], count: 3, lastItemId: items[2].id },
    ]);
  });

  it("authority schema field is path; file_path/filePath are fallbacks only; no path → skipped", () => {
    const items = [
      itemWithTool("write", { file_path: "/x/fallback.ts", content: "" }),
      itemWithTool("write", { filePath: "/x/fallback2.ts", content: "" }),
      itemWithTool("write", { path: "/x/authority.ts", file_path: "/x/not-used.ts", content: "" }),
      itemWithTool("write", { content: "no path at all" }),
    ];
    expect(outputEditsFromItems(items).map((o) => o.path)).toEqual([
      "/x/fallback.ts",
      "/x/fallback2.ts",
      "/x/authority.ts",
    ]);
  });

  it("ignores non-write tools — bash-edited files must not appear (spec boundary)", () => {
    const items = [
      itemWithTool("bash", { command: "echo hi > /x/a.ts" }),
      itemWithTool("read", { path: "/x/a.ts" }),
      itemWithTool("grep", { pattern: "x", path: "/x" }),
      itemWithTool("WRITE", { path: "/x/upper.ts", content: "" }), // case-tolerant
    ];
    expect(outputEditsFromItems(items).map((o) => o.path)).toEqual(["/x/upper.ts"]);
  });

  it("skips streaming blocks and unparseable/non-conforming argsJson", () => {
    const items = [
      itemWithTool("write", { path: "/x/streaming.ts", content: "" }, { done: false }),
      itemWithTool("write", "{broken json"),
      itemWithTool("write", { path: 42, content: "" }),
    ];
    expect(outputEditsFromItems(items)).toEqual([]);
  });

  it("is a pure function — no module-level accumulation between calls", () => {
    const items = [itemWithTool("write", { path: "/x/once.ts", content: "" })];
    const first = outputEditsFromItems(items);
    expect(outputEditsFromItems([])).toEqual([]);
    expect(outputEditsFromItems(items)).toEqual(first);
  });
});

describe("store: derivations follow the session (D4/D5 会话隔离, FR-007)", () => {
  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    resetSwitchGate();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    h.state.rpc.set("switch_session", () => ({}));
    h.state.rpc.set("new_session", () => ({}));
    h.state.rpc.set("get_messages", () => ({ messages: [] }));
    h.state.rpc.set("get_session_stats", () => ({}));
    h.state.rpc.set("get_state", () => ({ sessionId: "s-next" }));
    usePiStore.setState({ items: [], queue: { items: [], paused: false, pauseReason: null, drift: false } });
  });

  it("after a switch, derivations see only the new transcript (items are the only input)", async () => {
    usePiStore.setState({ items: [itemWithTool("write", { path: "/old/a.ts", content: "" })] });
    h.state.rpc.set("get_messages", () => ({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-b1", name: "write", arguments: { path: "/new/b.ts", content: "x" } }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-b2",
              name: "todo_write",
              arguments: { items: [{ text: "n1", status: "pending" }] },
            },
          ],
        },
      ],
    }));

    await usePiStore.getState().switchSession("/sessions/next.jsonl");

    const items = usePiStore.getState().items;
    expect(outputEditsFromItems(items).map((o) => o.path)).toEqual(["/new/b.ts"]);
    expect(todoSnapshotFromItems(items)).toEqual([{ text: "n1", status: "pending" }]);
  });

  it("a new session empties the transcript, so derivations empty out", async () => {
    usePiStore.setState({ items: [itemWithTool("write", { path: "/old/a.ts", content: "" })] });

    // A non-empty transcript asks first (007 FR-011); confirm through the dialog.
    await usePiStore.getState().newSession();
    const ask = usePiStore.getState().confirm;
    expect(ask).not.toBeNull();
    await ask!.onConfirm();

    expect(usePiStore.getState().items).toEqual([]);
    expect(outputEditsFromItems(usePiStore.getState().items)).toEqual([]);
    expect(todoSnapshotFromItems(usePiStore.getState().items)).toBeNull();
  });
});

// -- d) subagent async feed (D2) ----------------------------------------------

describe("parseSubagentAsyncWidget (D2 pure, probe-036 §4/§5 shapes)", () => {
  it("parses a snapshot frame: strip prefix, JSON.parse, kind+version validated", () => {
    const snap = snapshotOf([{ id: "r1", kind: "subagent", label: "scout", state: "running" }]);
    const out = parseSubagentAsyncWidget(asFrameLines(snap));
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("pi-subagents.async-status-snapshot");
    expect(out!.version).toBe(1);
    expect(out!.runs).toHaveLength(1);
    expect(out!.runs[0]).toMatchObject({ id: "r1", label: "scout", state: "running" });
    expect(out!.caps?.maxDepth).toBe(2);
    expect(out!.omitted?.children).toBe(0);
  });

  it("missing / empty / non-array widgetLines is the CLEAR semantics (probe §4 empty registration frame)", () => {
    expect(parseSubagentAsyncWidget(undefined)).toBeNull();
    expect(parseSubagentAsyncWidget([])).toBeNull();
    expect(parseSubagentAsyncWidget({})).toBeNull();
  });

  it("frames failing prefix / JSON / kind / version are DROPPED (undefined — no crash, no state change)", () => {
    expect(parseSubagentAsyncWidget(["PI_SUBAGENT_ASYNC_JSON:not json"])).toBeUndefined();
    expect(parseSubagentAsyncWidget(["PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(snapshotOf([], { kind: "other" }))])).toBeUndefined();
    expect(parseSubagentAsyncWidget(["PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify(snapshotOf([], { version: 2 }))])).toBeUndefined();
    expect(parseSubagentAsyncWidget(["no prefix here"])).toBeUndefined();
    expect(parseSubagentAsyncWidget([42])).toBeUndefined();
  });

  it("violating node shapes degrade instead of throwing (JSON 面无校验)", () => {
    const snap = snapshotOf([{ id: "r1", label: "no-state-node" }, "junk", null]);
    const out = parseSubagentAsyncWidget(asFrameLines(snap));
    expect(out!.runs).toHaveLength(1);
    expect(out!.runs[0].state).toBeUndefined();
    const withBadChild = snapshotOf([
      { id: "r1", label: "p", children: ["junk", { id: "c1", label: "ok", state: "complete" }] },
    ]);
    const out2 = parseSubagentAsyncWidget(asFrameLines(withBadChild));
    expect(out2!.runs[0].children).toHaveLength(1);
    expect(out2!.runs[0].children![0]).toMatchObject({ id: "c1", state: "complete" });
  });

  it("runs missing from the frame degrades to [] — only kind/version are the hard contract", () => {
    const out = parseSubagentAsyncWidget(
      asFrameLines({ kind: "pi-subagents.async-status-snapshot", version: 1 }),
    );
    expect(out!.runs).toEqual([]);
  });
});

describe("mapJobState (D2 八值→四态, plan table)", () => {
  it.each([
    ["running", "running"],
    ["queued", "running"],
    ["paused", "waiting"],
    ["complete", "done"],
    ["failed", "failed"],
    ["partial", "failed"],
    ["stopped", "failed"],
    ["rejected", "failed"],
  ])("%s → %s", (raw, badge) => {
    expect(mapJobState(raw)).toBe(badge);
  });

  it("matches case-insensitively", () => {
    expect(mapJobState("RUNNING")).toBe("running");
    expect(mapJobState("Complete")).toBe("done");
  });

  it("unknown values never get forced into a group (plan: 原样小写展示)", () => {
    expect(mapJobState("weird")).toBe("unknown");
  });

  it("missing / non-string state (wire contract violation) → unknown neutral badge", () => {
    expect(mapJobState(undefined)).toBe("unknown");
    expect(mapJobState(null)).toBe("unknown");
    expect(mapJobState(42)).toBe("unknown");
  });
});

describe("jobStepChain (D2 chain 步骤流)", () => {
  it("flattens the children tree depth-first with label + badge", () => {
    const snap = snapshotOf([
      {
        id: "r1",
        kind: "subagent",
        label: "scout",
        state: "complete",
        children: [
          {
            id: "c1",
            kind: "step",
            label: "worker",
            state: "running",
            children: [{ id: "g1", kind: "step", label: "reviewer", state: "queued" }],
          },
        ],
      },
    ]);
    const { steps, truncated } = jobStepChain(
      parseSubagentAsyncWidget(asFrameLines(snap)) as AsyncStatusSnapshot,
    );
    expect(steps).toEqual([
      { label: "scout", badge: "done" },
      { label: "worker", badge: "running" },
      { label: "reviewer", badge: "running" }, // queued → 运行中
    ]);
    expect(truncated).toBe(false);
  });

  it("caps recursion at caps.maxDepth and flags the truncation", () => {
    const snap = snapshotOf(
      [
        {
          id: "r1",
          label: "scout",
          state: "complete",
          children: [
            {
              id: "c1",
              label: "worker",
              state: "running",
              children: [{ id: "g1", label: "reviewer", state: "queued" }],
            },
          ],
        },
      ],
      { caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 1, maxStringLength: 4000, maxSerializedBytes: 65536 } },
    );
    const { steps, truncated } = jobStepChain(
      parseSubagentAsyncWidget(asFrameLines(snap)) as AsyncStatusSnapshot,
    );
    expect(steps.map((s) => s.label)).toEqual(["scout", "worker"]);
    expect(truncated).toBe(true);
  });

  it("omitted.children flags truncation even without a depth cut", () => {
    const snap = snapshotOf([{ id: "r1", label: "solo", state: "complete" }], {
      omitted: { runs: 0, children: 3, byteLimitExceeded: false },
    });
    expect(jobStepChain(parseSubagentAsyncWidget(asFrameLines(snap)) as AsyncStatusSnapshot)).toEqual({
      steps: [{ label: "solo", badge: "done" }],
      truncated: true,
    });
  });

  it("unknown states keep their lowercased raw value for display", () => {
    const snap = snapshotOf([{ id: "r1", label: "x", state: "Weird" }]);
    const { steps } = jobStepChain(parseSubagentAsyncWidget(asFrameLines(snap)) as AsyncStatusSnapshot);
    expect(steps[0]).toEqual({ label: "x", badge: "unknown", rawState: "weird" });
  });

  it("a missing label falls back to the node id", () => {
    const snap = snapshotOf([{ id: "r9", label: "", state: "complete" }]);
    const { steps } = jobStepChain(parseSubagentAsyncWidget(asFrameLines(snap)) as AsyncStatusSnapshot);
    expect(steps[0].label).toBe("r9");
  });

  it("null snapshot → empty chain", () => {
    expect(jobStepChain(null)).toEqual({ steps: [], truncated: false });
  });
});

describe("store: openOutput (D5 FR-006)", () => {
  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    resetSwitchGate();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
  });

  it("a working diff opens alone — no openFile fallback on the wire", async () => {
    h.state.methods.set("ide.showFileDiff", () => ({}));
    expect(await usePiStore.getState().openOutput("/x/a.ts")).toBe(true);
    expect(h.state.calls.map((c) => c.method)).toEqual(["ide.showFileDiff"]);
  });

  it("a refused diff (transport error) falls back to ide.openFile", async () => {
    h.state.methods.set("ide.showFileDiff", () => {
      throw new Error("diff unavailable");
    });
    h.state.methods.set("ide.openFile", () => ({ ok: true }));
    expect(await usePiStore.getState().openOutput("/x/a.ts")).toBe(true);
    expect(h.state.calls.map((c) => c.method)).toEqual(["ide.showFileDiff", "ide.openFile"]);
  });

  it("both refusing resolves false instead of pretending success", async () => {
    h.state.methods.set("ide.showFileDiff", () => {
      throw new Error("diff unavailable");
    });
    h.state.methods.set("ide.openFile", () => ({ ok: false }));
    expect(await usePiStore.getState().openOutput("/x/gone.ts")).toBe(false);
  });
});

describe("store: subagent-async widget feed (D2)", () => {
  const dispatchPi = (data: Record<string, unknown>) => h.state.piHandler?.("pi", data);
  const widget = (widgetLines: unknown) => ({
    type: "extension_ui_request",
    id: "w",
    method: "setWidget",
    widgetKey: "subagent-async",
    ...(widgetLines === undefined ? {} : { widgetLines }),
  });

  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    resetSwitchGate();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({ piStatus: "running", subagentAsync: { seen: false, snapshot: null, updatedAt: 0 } });
    h.state.rpc.set("switch_session", () => ({}));
    h.state.rpc.set("new_session", () => ({}));
    h.state.rpc.set("get_messages", () => ({ messages: [] }));
    h.state.rpc.set("get_session_stats", () => ({}));
    h.state.rpc.set("get_state", () => ({ sessionId: "s-next" }));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSubagentThrottle();
  });

  it("any subagent-async widget — even the empty registration frame — flips seen immediately", () => {
    dispatchPi(widget(undefined));
    expect(usePiStore.getState().subagentAsync.seen).toBe(true);
    expect(usePiStore.getState().subagentAsync.snapshot).toBeNull();
  });

  it("the snapshot lands through the ~250ms trailing flush, not earlier", async () => {
    vi.useFakeTimers();
    dispatchPi(widget(asFrameLines(snapshotOf([{ id: "r1", label: "scout", state: "running" }]))));
    expect(usePiStore.getState().subagentAsync.seen).toBe(true);
    expect(usePiStore.getState().subagentAsync.snapshot).toBeNull(); // armed, not flushed

    await vi.advanceTimersByTimeAsync(SUBAGENT_FLUSH_MS);

    expect(usePiStore.getState().subagentAsync.snapshot?.runs[0]).toMatchObject({
      id: "r1",
      label: "scout",
      state: "running",
    });
  });

  it("a burst inside the window merges into one flush — the latest snapshot wins (整体替换)", async () => {
    vi.useFakeTimers();
    dispatchPi(widget(asFrameLines(snapshotOf([{ id: "r1", label: "old", state: "running" }]))));
    await vi.advanceTimersByTimeAsync(100);
    dispatchPi(widget(asFrameLines(snapshotOf([{ id: "r1", label: "new", state: "complete" }]))));
    await vi.advanceTimersByTimeAsync(150); // reaches the flush armed at t0

    const snapshot = usePiStore.getState().subagentAsync.snapshot;
    expect(snapshot?.runs).toHaveLength(1);
    expect(snapshot?.runs[0]).toMatchObject({ label: "new", state: "complete" });
  });

  it("invalid frames drop wholesale — the previous snapshot survives, seen still flips", async () => {
    vi.useFakeTimers();
    dispatchPi(widget(asFrameLines(snapshotOf([{ id: "r1", label: "keep", state: "running" }]))));
    await vi.advanceTimersByTimeAsync(SUBAGENT_FLUSH_MS);
    expect(usePiStore.getState().subagentAsync.snapshot?.runs[0].label).toBe("keep");

    for (const bad of ["PI_SUBAGENT_ASYNC_JSON:not json", "no prefix", ...asFrameLines(snapshotOf([], { version: 2 }))]) {
      dispatchPi(widget([bad]));
    }
    await vi.advanceTimersByTimeAsync(SUBAGENT_FLUSH_MS);

    expect(usePiStore.getState().subagentAsync.snapshot?.runs[0].label).toBe("keep");
    expect(usePiStore.getState().subagentAsync.seen).toBe(true);
  });

  it("a missing widgetLines AFTER a snapshot is the clear semantics (probe §4)", async () => {
    vi.useFakeTimers();
    dispatchPi(widget(asFrameLines(snapshotOf([{ id: "r1", label: "gone soon", state: "running" }]))));
    await vi.advanceTimersByTimeAsync(SUBAGENT_FLUSH_MS);
    expect(usePiStore.getState().subagentAsync.snapshot).not.toBeNull();

    dispatchPi(widget(undefined));
    await vi.advanceTimersByTimeAsync(SUBAGENT_FLUSH_MS);
    expect(usePiStore.getState().subagentAsync.snapshot).toBeNull();
    expect(usePiStore.getState().subagentAsync.seen).toBe(true);
  });

  it("a channel-B inspect widget (subagent-inspect) never trips the subagent-async seen flag", () => {
    dispatchPi({
      type: "extension_ui_request",
      id: "i1",
      method: "setWidget",
      widgetKey: "subagent-inspect",
      widgetLines: ["PI_SUBAGENT_INSPECT_JSON:{}"],
    });
    expect(usePiStore.getState().subagentAsync.seen).toBe(false);
  });

  it("switchSession clears the snapshot but keeps seen (D2 会话切换重置)", async () => {
    vi.useFakeTimers();
    dispatchPi(widget(asFrameLines(snapshotOf([{ id: "r1", label: "scout", state: "running" }]))));
    await vi.advanceTimersByTimeAsync(SUBAGENT_FLUSH_MS);
    expect(usePiStore.getState().subagentAsync.snapshot).not.toBeNull();

    vi.useRealTimers();
    await usePiStore.getState().switchSession("/sessions/next.jsonl");

    const s = usePiStore.getState().subagentAsync;
    expect(s.snapshot).toBeNull();
    expect(s.seen).toBe(true);
  });

  it("newSession clears the snapshot too (resetConversationLocalState), keeping seen", async () => {
    vi.useFakeTimers();
    dispatchPi(widget(asFrameLines(snapshotOf([{ id: "r1", label: "scout", state: "running" }]))));
    await vi.advanceTimersByTimeAsync(SUBAGENT_FLUSH_MS);
    expect(usePiStore.getState().subagentAsync.snapshot).not.toBeNull();

    vi.useRealTimers();
    const done = usePiStore.getState().newSession();
    // The reset is synchronous, before pi answers the RPC.
    expect(usePiStore.getState().subagentAsync.snapshot).toBeNull();
    expect(usePiStore.getState().subagentAsync.seen).toBe(true);
    await done;
  });
});

// -- e) panel popover state (U2 三弹层互斥) + approval jump (D6) ------------------

describe("store: status panel popover (U2/D6)", () => {
  const dispatchPi = (data: Record<string, unknown>) => h.state.piHandler?.("pi", data);

  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    resetSwitchGate();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({
      piStatus: "running",
      statusPanelOpen: false,
      outlineOpen: false,
      search: { open: false, query: "", index: 0 },
      approvals: [],
      tab: "chat",
    });
    h.state.rpc.set("switch_session", () => ({}));
    h.state.rpc.set("new_session", () => ({}));
    h.state.rpc.set("get_messages", () => ({ messages: [] }));
    h.state.rpc.set("get_session_stats", () => ({}));
    h.state.rpc.set("get_state", () => ({ sessionId: "s-next" }));
  });

  it("toggleStatusPanel flips the popover; the no-arg form toggles, the explicit form sets", () => {
    expect(usePiStore.getState().statusPanelOpen).toBe(false);
    usePiStore.getState().toggleStatusPanel();
    expect(usePiStore.getState().statusPanelOpen).toBe(true);
    usePiStore.getState().toggleStatusPanel();
    expect(usePiStore.getState().statusPanelOpen).toBe(false);
    usePiStore.getState().toggleStatusPanel(true);
    expect(usePiStore.getState().statusPanelOpen).toBe(true);
    usePiStore.getState().toggleStatusPanel(false);
    expect(usePiStore.getState().statusPanelOpen).toBe(false);
  });

  it("opening the status panel closes the outline AND the search (FR-001 同一时刻只开一个)", () => {
    usePiStore.setState({ outlineOpen: true, search: { open: true, query: "q", index: 0 } });
    usePiStore.getState().toggleStatusPanel(true);
    expect(usePiStore.getState().statusPanelOpen).toBe(true);
    expect(usePiStore.getState().outlineOpen).toBe(false);
    expect(usePiStore.getState().search.open).toBe(false);
  });

  it("closing the status panel does not open anything else", () => {
    usePiStore.getState().toggleStatusPanel(true);
    usePiStore.getState().toggleStatusPanel(false);
    expect(usePiStore.getState().outlineOpen).toBe(false);
    expect(usePiStore.getState().search.open).toBe(false);
    expect(usePiStore.getState().statusPanelOpen).toBe(false);
  });

  it("toggleOutline closing the panel: opening the outline closes the status panel (not vice versa on close)", () => {
    usePiStore.getState().toggleStatusPanel(true);
    usePiStore.getState().toggleOutline(true);
    expect(usePiStore.getState().outlineOpen).toBe(true);
    expect(usePiStore.getState().statusPanelOpen).toBe(false);

    // outline closing must not resurrect the panel
    usePiStore.getState().toggleOutline(false);
    expect(usePiStore.getState().statusPanelOpen).toBe(false);
  });

  it("openSearch closes the status panel; closeSearch does not reopen it", () => {
    usePiStore.getState().toggleStatusPanel(true);
    usePiStore.getState().openSearch();
    expect(usePiStore.getState().search.open).toBe(true);
    expect(usePiStore.getState().statusPanelOpen).toBe(false);

    usePiStore.getState().toggleStatusPanel(true);
    usePiStore.getState().closeSearch();
    expect(usePiStore.getState().statusPanelOpen).toBe(true);
  });

  it("outline and search still coexist — the status panel is the only exclusive one (U2 范围红线)", () => {
    usePiStore.getState().toggleOutline(true);
    usePiStore.getState().openSearch();
    expect(usePiStore.getState().outlineOpen).toBe(true);
    expect(usePiStore.getState().search.open).toBe(true);
  });

  it("session switch and new session keep the panel open (U2: 运行状态跨会话仍有意义)", async () => {
    usePiStore.getState().toggleStatusPanel(true);
    await usePiStore.getState().switchSession("/sessions/next.jsonl");
    expect(usePiStore.getState().statusPanelOpen).toBe(true);

    const done = usePiStore.getState().newSession();
    expect(usePiStore.getState().statusPanelOpen).toBe(true);
    await done;
  });

  it("goToApproval switches to the chat tab, flashes the queue-head card (D6 FR-004)", async () => {
    dispatchPi({ type: "extension_ui_request", id: "a1", method: "confirm", title: "Allow bash?", message: "{}" });
    expect(usePiStore.getState().approvals).toHaveLength(1);
    usePiStore.setState({ tab: "manage" });

    // jsdom has no layout: assert the store contract — the tab flips, and the
    // DOM side (scroll+flash) is e2e's job (geometry, constitution II).
    await usePiStore.getState().goToApproval();
    expect(usePiStore.getState().tab).toBe("chat");
  });

  it("goToApproval with no pending approvals still just switches the tab (no crash)", async () => {
    usePiStore.setState({ tab: "sessions" });
    await usePiStore.getState().goToApproval();
    expect(usePiStore.getState().tab).toBe("chat");
  });
});
