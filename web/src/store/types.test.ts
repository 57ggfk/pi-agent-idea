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
  it("adds a user item on message_start", () => {
    const items = applyEvent([], {
      type: "message_start",
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
});
