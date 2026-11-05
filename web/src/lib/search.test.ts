import { describe, expect, it, beforeEach } from "vitest";
import { hitsFromItems } from "./search";
import { resetItemIds, emptyItem } from "../store/types";
import type { ChatItem } from "../store/types";

function user(text: string): ChatItem {
  const item = emptyItem("user", [{ kind: "text", text, done: true }]);
  item.done = true;
  return item;
}

function assistant(text: string): ChatItem {
  const item = emptyItem("assistant", [{ kind: "text", text, done: true }]);
  item.done = true;
  return item;
}

beforeEach(() => resetItemIds());

describe("hitsFromItems", () => {
  it("finds multiple hits in one block with ascending offsets", () => {
    const items = [user("timeout here"), assistant("a timeout and another timeout later")];
    const hits = hitsFromItems(items, "timeout");
    expect(hits.map((h) => [h.itemId, h.offset])).toEqual([
      [1, 0],
      [2, 2],
      [2, 22],
    ]);
    expect(hits.every((h) => h.kind === "text")).toBe(true);
    expect(hits.every((h) => h.length === "timeout".length)).toBe(true);
  });

  it("spans blocks and items in transcript order", () => {
    const items = [assistant("alpha one"), user("beta"), assistant("alpha two")];
    const hits = hitsFromItems(items, "alpha");
    expect(hits).toHaveLength(2);
    expect(hits[0].itemId).toBe(1);
    expect(hits[1].itemId).toBe(3);
  });

  it("is case-insensitive for latin text", () => {
    const items = [assistant("TimeOut and timeout")];
    expect(hitsFromItems(items, "timeout")).toHaveLength(2);
  });

  it("matches CJK substrings", () => {
    const items = [assistant("会话内搜索很快"), user("搜索引擎")];
    const hits = hitsFromItems(items, "搜索");
    expect(hits).toHaveLength(2);
    expect(hits[0].offset).toBe(3); // 会(0) 话(1) 内(2) 搜(3)
    expect(hits[1].offset).toBe(0);
  });

  it("treats regex metacharacters literally", () => {
    const items = [assistant("a.b (c) d* e"), assistant("aXb (c)")];
    expect(hitsFromItems(items, "a.b")).toHaveLength(1);
    expect(hitsFromItems(items, "(c)")).toHaveLength(2);
    expect(hitsFromItems(items, "d*")).toHaveLength(1);
  });

  it("returns no hits for an empty or blank query", () => {
    const items = [user("hello"), assistant("world")];
    expect(hitsFromItems(items, "")).toEqual([]);
    expect(hitsFromItems(items, "   ")).toEqual([]);
  });

  it("never matches thinking blocks or image data", () => {
    const thinkItem = emptyItem("assistant", [
      { kind: "thinking", text: "secret timeout plan", done: true },
      { kind: "text", text: "public answer", done: true },
    ]);
    thinkItem.done = true;
    const imgItem = emptyItem("user", [{ kind: "image", data: "timeoutbase64", mimeType: "image/png" }]);
    const items = [thinkItem, imgItem];
    expect(hitsFromItems(items, "timeout")).toEqual([]);
  });

  it("searches tool output with kind=tool-output", () => {
    const toolItem = emptyItem("assistant", [
      {
        kind: "toolcall",
        id: "t1",
        toolName: "bash",
        argsJson: "{}",
        done: true,
        result: { output: "line1\ncritical timeout happened", isError: false },
      },
    ]);
    toolItem.done = true;
    const hits = hitsFromItems([toolItem], "timeout");
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("tool-output");
    expect(hits[0].blockIndex).toBe(0);
    expect(hits[0].offset).toBe("line1\ncritical ".length);
  });

  it("gives each hit a preview around the match", () => {
    const long = "x".repeat(120) + "needle" + "y".repeat(120);
    const hits = hitsFromItems([assistant(long)], "needle");
    expect(hits).toHaveLength(1);
    expect(hits[0].preview).toContain("needle");
    expect(hits[0].preview.length).toBeLessThan(160);
  });

  it("trims the query but keeps interior spacing", () => {
    const items = [assistant("a  b")];
    expect(hitsFromItems(items, " a  b ")).toHaveLength(1);
    expect(hitsFromItems(items, "a b")).toHaveLength(0);
  });
});
