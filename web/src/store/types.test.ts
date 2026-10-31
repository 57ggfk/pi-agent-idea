import { describe, expect, it, beforeEach } from "vitest";
import {
  applyEvent,
  emptyItem,
  itemsFromMessages,
  resetItemIds,
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
