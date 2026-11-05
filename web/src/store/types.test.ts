import { describe, expect, it, beforeEach } from "vitest";
import {
  actionsForItem,
  applyEvent,
  approvalFromEvent,
  emptyItem,
  itemHasText,
  itemToMarkdownSource,
  itemsFromMessages,
  quoteMarkdownSource,
  resetItemIds,
  type ActionContext,
  type ChatItem,
  type ContentBlock,
} from "./types";

function toolBlockOf(item: ChatItem | undefined): Extract<ContentBlock, { kind: "toolcall" }> | undefined {
  if (!item) return undefined;
  const b = item.blocks.find((x) => x.kind === "toolcall");
  return b as Extract<ContentBlock, { kind: "toolcall" }> | undefined;
}

function textOf(items: ChatItem[], index: number): string {
  return items[index].blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

beforeEach(() => resetItemIds());

describe("applyEvent", () => {
  it("adds a user item on message_end (message_start is ignored for users)", () => {
    const items = applyEvent([], {
      type: "message_end",
      message: { role: "user", content: "hello", timestamp: 1 },
    });
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe("user");
    expect(textOf(items, 0)).toBe("hello");
    expect(items[0].done).toBe(true);
  });

  it("does not duplicate optimistic user message with same text", () => {
    const optimistic = emptyItem("user", [{ kind: "text", text: "hi", done: true }]);
    optimistic.done = true;
    const items = applyEvent([optimistic], {
      type: "message_start",
      message: { role: "user", content: "hi", timestamp: 2 },
    });
    expect(items).toHaveLength(1);
  });

  it("accumulates text deltas and replaces on text_end", () => {
    let items = applyEvent([], { type: "message_start", message: { role: "assistant", content: [] } });
    items = applyEvent(items, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    items = applyEvent(items, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
    items = applyEvent(items, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } });
    expect(textOf(items, 0)).toBe("Hello");
    items = applyEvent(items, { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello world" } });
    expect(textOf(items, 0)).toBe("Hello world");
  });

  it("keeps thinking and text blocks apart by contentIndex", () => {
    let items = applyEvent([], { type: "message_start", message: { role: "assistant", content: [] } });
    items = applyEvent(items, { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    items = applyEvent(items, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "pondering" } });
    items = applyEvent(items, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } });
    items = applyEvent(items, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "answer" } });
    const blocks = items[0].blocks;
    expect(blocks[0].kind).toBe("thinking");
    expect(blocks[1].kind).toBe("text");
    expect((blocks[0] as { text: string }).text).toBe("pondering");
    expect((blocks[1] as { text: string }).text).toBe("answer");
  });

  it("tracks toolcall lifecycle and execution results", () => {
    let items = applyEvent([], { type: "message_start", message: { role: "assistant", content: [] } });
    items = applyEvent(items, {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" },
    });
    items = applyEvent(items, {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"}' },
    });
    items = applyEvent(items, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "call_1", name: "bash", arguments: { command: "ls -la" } },
      },
    });
    let block = toolBlockOf(items[0])!;
    expect(block.id).toBe("call_1");
    expect(block.toolName).toBe("bash");
    expect(JSON.parse(block.argsJson)).toEqual({ command: "ls -la" });
    expect(block.done).toBe(true);

    items = applyEvent(items, { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: {} });
    block = toolBlockOf(items[0])!;
    expect(block.result?.output).toBe("");

    items = applyEvent(items, {
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });
    block = toolBlockOf(items[0])!;
    expect(block.result?.output).toBe("partial");

    items = applyEvent(items, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "full output" }] },
      isError: false,
      durationMs: 120,
    });
    block = toolBlockOf(items[0])!;
    expect(block.result?.output).toBe("full output");
    expect(block.result?.isError).toBe(false);
    expect(block.result?.durationMs).toBe(120);
  });

  it("message_end replaces the assistant message authoritatively", () => {
    let items = applyEvent([], { type: "message_start", message: { role: "assistant", content: [] } });
    items = applyEvent(items, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "stale" } });
    items = applyEvent(items, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final text" }],
        stopReason: "endTurn",
        usage: { input: 10, output: 5, totalTokens: 15 },
      },
    });
    expect(items[0].done).toBe(true);
    expect(textOf(items, 0)).toBe("final text");
    expect(items[0].usage?.totalTokens).toBe(15);
  });

  it("creates a synthetic tool card for tool execution without streamed toolcall", () => {
    const items = applyEvent([], {
      type: "tool_execution_start",
      toolCallId: "call_x",
      toolName: "read",
      args: { path: "/tmp/f" },
    });
    const block = toolBlockOf(items[0])!;
    expect(block.toolName).toBe("read");
    expect(block.id).toBe("call_x");
  });

  it("compaction events add system notices", () => {
    let items = applyEvent([], { type: "compaction_start", reason: "threshold" });
    expect(items[0].role).toBe("system");
    items = applyEvent(items, {
      type: "compaction_end",
      reason: "threshold",
      result: { summary: "s", tokensBefore: 100, estimatedTokensAfter: 20 },
    });
    expect(items).toHaveLength(2);
    expect(textOf(items, 1)).toContain("100");
    expect(textOf(items, 1)).toContain("20");
  });

  it("ignores events without type", () => {
    expect(applyEvent([], {})).toHaveLength(0);
  });
});

describe("itemsFromMessages", () => {
  it("replays messages into chat items", () => {
    const items = itemsFromMessages([
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "answer" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
        usage: { totalTokens: 42 },
      },
      { role: "toolRun", content: [] }, // non-chat roles are skipped
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].blocks[0]).toMatchObject({ kind: "text", text: "question" });
    expect(items[1].blocks.map((b) => b.kind)).toEqual(["thinking", "text", "toolcall"]);
    expect(items[1].usage?.totalTokens).toBe(42);
  });

  it("maps image blocks from both the anthropic and the flat wire shape", () => {
    const items = itemsFromMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } },
          { type: "image", mimeType: "image/jpeg", data: "data:image/jpeg;base64,BBBB" },
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].blocks[1]).toEqual({ kind: "image", data: "AAAA", mimeType: "image/png" });
    // data: URL prefixes are stripped to plain base64
    expect(items[0].blocks[2]).toEqual({ kind: "image", data: "BBBB", mimeType: "image/jpeg" });
  });

  it("folds toolResult messages back into their tool card so the output survives", () => {
    const items = itemsFromMessages([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "README.md\nsrc" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    // The result message does not become its own transcript item.
    expect(items).toHaveLength(3);
    const block = items[1].blocks[0];
    expect(block).toMatchObject({
      kind: "toolcall",
      id: "c1",
      done: true,
      result: { output: "README.md\nsrc", isError: false },
    });
  });

  it("keeps an orphaned toolResult as its own card instead of dropping it", () => {
    const items = itemsFromMessages([
      {
        role: "toolResult",
        toolCallId: "c9",
        toolName: "bash",
        content: [{ type: "text", text: "boom" }],
        isError: true,
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].blocks[0]).toMatchObject({
      kind: "toolcall",
      id: "c9",
      toolName: "bash",
      result: { output: "boom", isError: true },
    });
  });
});

describe("user images", () => {
  it("keeps the optimistic image blocks when pi finalizes the same text", () => {
    const optimistic = emptyItem("user", [
      { kind: "text", text: "what is this", done: true },
      { kind: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    optimistic.done = true;
    const items = applyEvent([optimistic], {
      type: "message_end",
      message: {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "BBBB" } },
        ],
      },
    });
    // The optimistic copy (with the image) stays; no duplicate appended.
    expect(items).toHaveLength(1);
    expect(items[0].blocks.map((b) => b.kind)).toEqual(["text", "image"]);
  });
});

describe("provider error surfacing", () => {
  it("message_update error event replaces the streaming item with a visible error", () => {
    let items = applyEvent([], { type: "message_start", message: { role: "assistant", content: [] } });
    items = applyEvent(items, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } });
    items = applyEvent(items, {
      type: "message_update",
      assistantMessageEvent: { type: "error", reason: "api", error: '404: No endpoints available' },
    });
    expect(items[0].done).toBe(true);
    expect(items[0].isError).toBe(true);
    expect(textOf(items, 0)).toContain("404");
  });

  it("message_end with errorMessage and no content shows the error", () => {
    const items = applyEvent([], {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: '404: {"message":"No endpoints available"}',
      },
    });
    expect(items[0].isError).toBe(true);
    expect(textOf(items, 0)).toContain("No endpoints available");
  });

  it("message_end with errorMessage keeps existing text and just flags the item", () => {
    const items = applyEvent([], {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial answer before failure" }],
        stopReason: "error",
        errorMessage: "connection reset",
      },
    });
    expect(items[0].isError).toBe(true);
    expect(textOf(items, 0)).toContain("partial answer before failure");
  });

  it("duplicate assistant message_start does not create an empty item", () => {
    const start = { type: "message_start", message: { role: "assistant", content: [] } };
    let items = applyEvent([], start);
    items = applyEvent(items, start);
    expect(items).toHaveLength(1);
  });
});

describe("real-pi user message dedupe", () => {
  it("ignores message_start variants and dedupes message_end against the optimistic item", () => {
    // optimistic item added by the store before events arrive (modeled as the
    // message_end-derived shape the store creates)
    let items = applyEvent([], { type: "message_end", message: { role: "user", content: "Say OK" } });
    // real pi: message_start carries empty array content and is ignored
    items = applyEvent(items, { type: "message_start", message: { role: "user", content: [] } });
    // message_end finalizes; identical tail is deduped, not appended
    items = applyEvent(items, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Say OK" }] } });
    expect(items).toHaveLength(1);
    expect(textOf(items, 0)).toBe("Say OK");
  });

  it("message_start with empty content does not create an empty user item", () => {
    const items = applyEvent([], { type: "message_start", message: { role: "user", content: [] } });
    expect(items).toHaveLength(0);
  });

  it("a distinct user message via message_end is appended", () => {
    let items = applyEvent([], { type: "message_end", message: { role: "user", content: "first" } });
    items = applyEvent(items, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "second" }] } });
    expect(items).toHaveLength(2);
    expect(textOf(items, 1)).toBe("second");
  });
});

describe("approvalFromEvent", () => {
  it("parses a confirm dialog request", () => {
    const a = approvalFromEvent({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "Allow bash?",
      message: '{"command": "rm -rf /"}',
      timeout: 300000,
    });
    expect(a).not.toBeNull();
    expect(a!.id).toBe("ui-1");
    expect(a!.method).toBe("confirm");
    expect(a!.title).toBe("Allow bash?");
    expect(a!.message).toContain("rm -rf");
    expect(a!.timeoutMs).toBe(300000);
    expect(typeof a!.receivedAt).toBe("number");
  });

  it("parses select requests with their options", () => {
    const a = approvalFromEvent({
      type: "extension_ui_request",
      id: "ui-2",
      method: "select",
      title: "Pick one",
      options: ["Allow", "Block"],
    });
    expect(a).not.toBeNull();
    expect(a!.method).toBe("select");
    expect(a!.options).toEqual(["Allow", "Block"]);
  });

  it("returns null for fire-and-forget methods", () => {
    expect(approvalFromEvent({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" })).toBeNull();
    expect(approvalFromEvent({ type: "extension_ui_request", id: "n2", method: "setStatus" })).toBeNull();
    expect(approvalFromEvent({ type: "extension_ui_request", id: "n3", method: "setWidget" })).toBeNull();
  });

  it("returns null for non-dialog events and requests without an id", () => {
    expect(approvalFromEvent({ type: "agent_start" })).toBeNull();
    expect(approvalFromEvent({ type: "message_update" })).toBeNull();
    expect(approvalFromEvent({ type: "extension_ui_request", method: "confirm" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Message actions: Markdown source + applicability matrix
// ---------------------------------------------------------------------------

function userItem(text: string, extra: ContentBlock[] = []): ChatItem {
  const item = emptyItem("user", [{ kind: "text", text, done: true }, ...extra]);
  item.done = true;
  return item;
}

function assistantItem(blocks: ContentBlock[]): ChatItem {
  const item = emptyItem("assistant", blocks);
  item.done = true;
  return item;
}

// A steady-state conversation: idle, the item is in the middle, and there is a
// user message above it (so 007's Fork is available unless a case says no).
const IDLE: ActionContext = {
  isLastUser: false,
  isLastAssistant: false,
  hasPrecedingUser: true,
  sessionBusy: false,
  editing: false,
};

describe("itemToMarkdownSource", () => {
  it("joins multiple text blocks with a paragraph break, keeping Markdown markers", () => {
    const item = assistantItem([
      { kind: "text", text: "Intro with a list:/n/n- one\n- two", done: true },
      { kind: "text", text: "```kotlin\nval x = 1\n```", done: true },
    ]);
    expect(itemToMarkdownSource(item)).toBe(
      "Intro with a list:/n/n- one\n- two\n\n```kotlin\nval x = 1\n```",
    );
  });

  it("returns a single block verbatim — a user message copies character-exact", () => {
    const item = userItem("line 1\nline 2\n");
    expect(itemToMarkdownSource(item)).toBe("line 1\nline 2\n");
  });

  it("ignores thinking, tool calls and image data", () => {
    const item = assistantItem([
      { kind: "thinking", text: "SECRET REASONING", done: true },
      { kind: "image", data: "AAAA", mimeType: "image/png" },
      {
        kind: "toolcall",
        id: "c1",
        toolName: "bash",
        argsJson: '{"command":"ls"}',
        done: true,
        result: { output: "TOOL OUTPUT", isError: false },
      },
      { kind: "text", text: "Only this survives.", done: true },
    ]);
    expect(itemToMarkdownSource(item)).toBe("Only this survives.");
  });

  it("returns null for a pure-image message", () => {
    const item = userItem("", [{ kind: "image", data: "AAAA", mimeType: "image/png" }]);
    const imageOnly = { ...item, blocks: item.blocks.filter((b) => b.kind !== "text") };
    expect(itemToMarkdownSource(imageOnly)).toBeNull();
  });

  it("returns null when every text block is blank", () => {
    const item = assistantItem([
      { kind: "text", text: "", done: true },
      { kind: "text", text: "   \n", done: true },
    ]);
    expect(itemToMarkdownSource(item)).toBeNull();
  });

  it("skips blank blocks but keeps the real ones", () => {
    const item = assistantItem([
      { kind: "text", text: "", done: true },
      { kind: "text", text: "answer", done: true },
    ]);
    expect(itemToMarkdownSource(item)).toBe("answer");
  });
});

describe("itemHasText", () => {
  it("is false for whitespace-only content", () => {
    expect(itemHasText(assistantItem([{ kind: "text", text: "  \n", done: true }]))).toBe(false);
    expect(itemHasText(assistantItem([{ kind: "image", data: "AA", mimeType: "image/png" }]))).toBe(false);
  });

  it("is true when a text block has content", () => {
    expect(itemHasText(userItem("hi"))).toBe(true);
  });
});

describe("actionsForItem", () => {
  it("gives a middle user message copy and quote but no edit (FR-002/FR-009)", () => {
    expect(actionsForItem(userItem("earlier prompt"), IDLE)).toEqual(["copy", "quote"]);
  });

  it("adds edit to the last user message while idle (FR-009)", () => {
    expect(actionsForItem(userItem("last prompt"), { ...IDLE, isLastUser: true })).toEqual([
      "copy",
      "quote",
      "edit",
    ]);
  });

  it("adds regenerate to the last assistant message while idle (FR-008)", () => {
    const item = assistantItem([{ kind: "text", text: "answer", done: true }]);
    expect(actionsForItem(item, { ...IDLE, isLastAssistant: true })).toEqual([
      "copy",
      "quote",
      "fork",
      "regenerate",
    ]);
  });

  it("never offers regenerate on a middle assistant message (FR-008)", () => {
    const item = assistantItem([{ kind: "text", text: "answer", done: true }]);
    expect(actionsForItem(item, IDLE)).toEqual(["copy", "quote", "fork"]);
  });

  it("hides the whole toolbar on a streaming assistant message (FR-001)", () => {
    const item = emptyItem("assistant", [{ kind: "text", text: "partial", done: false }]);
    expect(actionsForItem(item, { ...IDLE, isLastAssistant: true })).toEqual([]);
  });

  it("keeps copy on history messages while a later run is streaming", () => {
    const item = assistantItem([{ kind: "text", text: "old answer", done: true }]);
    expect(actionsForItem(item, { ...IDLE, sessionBusy: true })).toEqual(["copy", "quote"]);
  });

  it("hides copy and quote on a pure-image message (FR-007)", () => {
    const item = assistantItem([{ kind: "image", data: "AAAA", mimeType: "image/png" }]);
    expect(actionsForItem(item, { ...IDLE, isLastAssistant: true })).toEqual(["fork", "regenerate"]);
  });

  it("offers nothing on a pure-image user message — there is no text to edit", () => {
    const item = userItem("", [{ kind: "image", data: "AAAA", mimeType: "image/png" }]);
    expect(actionsForItem(item, { ...IDLE, isLastUser: true })).toEqual([]);
  });

  it("offers copy on an error item so it can be pasted into a bug report (FR-013)", () => {
    const item = emptyItem("system", [{ kind: "text", text: "⚠ 404: no endpoints", done: true }]);
    item.done = true;
    item.isError = true;
    expect(actionsForItem(item, IDLE)).toEqual(["copy"]);
  });

  it("offers nothing on an ordinary system notice (FR-001)", () => {
    const item = emptyItem("system", [{ kind: "text", text: "Context compacted", done: true }]);
    item.done = true;
    expect(actionsForItem(item, IDLE)).toEqual([]);
  });

  it("blocks regenerate and edit while a run is in flight (FR-010)", () => {
    const busy: ActionContext = { ...IDLE, sessionBusy: true, isLastUser: true, isLastAssistant: true };
    expect(actionsForItem(userItem("last"), busy)).toEqual(["copy", "quote"]);
    expect(actionsForItem(assistantItem([{ kind: "text", text: "answer", done: true }]), busy)).toEqual([
      "copy",
      "quote",
    ]);
  });

  it("blocks regenerate while an edit owns the composer (FR-010)", () => {
    const editing: ActionContext = { ...IDLE, editing: true, isLastAssistant: true };
    expect(actionsForItem(assistantItem([{ kind: "text", text: "answer", done: true }]), editing)).toEqual([
      "copy",
      "quote",
    ]);
  });

  it("leaves a failed assistant answer copyable and regenerable", () => {
    const item = assistantItem([{ kind: "text", text: "⚠ connection reset", done: true }]);
    item.isError = true;
    expect(actionsForItem(item, { ...IDLE, isLastAssistant: true })).toEqual([
      "copy",
      "quote",
      "fork",
      "regenerate",
    ]);
  });

  // -- 007 US1: Fork on pi replies ------------------------------------------

  it("offers Fork on a middle pi reply (007 FR-001)", () => {
    const item = assistantItem([{ kind: "text", text: "answer", done: true }]);
    expect(actionsForItem(item, IDLE)).toContain("fork");
  });

  it("offers Fork on the last pi reply too — the clone case (007 FR-004)", () => {
    const item = assistantItem([{ kind: "text", text: "answer", done: true }]);
    expect(actionsForItem(item, { ...IDLE, isLastAssistant: true })).toContain("fork");
  });

  it("never offers Fork on a user or system message (007 FR-001)", () => {
    expect(actionsForItem(userItem("prompt"), IDLE)).not.toContain("fork");
    const notice = emptyItem("system", [{ kind: "text", text: "Context compacted", done: true }]);
    notice.done = true;
    expect(actionsForItem(notice, IDLE)).not.toContain("fork");
  });

  it("hides Fork while a run is in flight (007 FR-002)", () => {
    const item = assistantItem([{ kind: "text", text: "old answer", done: true }]);
    expect(actionsForItem(item, { ...IDLE, sessionBusy: true })).not.toContain("fork");
  });

  it("hides Fork during a streaming reply — no toolbar at all (007 FR-002)", () => {
    const item = emptyItem("assistant", [{ kind: "text", text: "partial", done: false }]);
    expect(actionsForItem(item, { ...IDLE, hasPrecedingUser: true })).not.toContain("fork");
  });

  it("hides Fork when no user message precedes the reply (007 edge case)", () => {
    const item = assistantItem([{ kind: "text", text: "answer", done: true }]);
    expect(actionsForItem(item, { ...IDLE, hasPrecedingUser: false })).not.toContain("fork");
  });

  it("keeps copy and quote next to Fork (007 FR-002)", () => {
    const item = assistantItem([{ kind: "text", text: "answer", done: true }]);
    const actions = actionsForItem(item, IDLE);
    expect(actions).toContain("copy");
    expect(actions).toContain("quote");
  });
});

describe("quoteMarkdownSource", () => {
  it("prefixes every line so the quote stays one block", () => {
    expect(quoteMarkdownSource("one\ntwo")).toBe("> one\n> two");
  });

  it("keeps blank lines as a bare > instead of splitting the quote", () => {
    expect(quoteMarkdownSource("para one\n\npara two")).toBe("> para one\n>\n> para two");
  });

  it("leaves fenced code untouched — the composer is plain text", () => {
    expect(quoteMarkdownSource("```js\nx()\n```")).toBe("> ```js\n> x()\n> ```");
  });

  it("round-trips a single line unchanged apart from the prefix", () => {
    expect(quoteMarkdownSource("hello")).toBe("> hello");
  });
});
