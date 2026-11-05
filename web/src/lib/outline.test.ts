import { describe, expect, it, beforeEach } from "vitest";
import { outlineEntries, OUTLINE_IMAGE_PLACEHOLDER } from "./outline";
import { resetItemIds, emptyItem } from "../store/types";
import type { ChatItem } from "../store/types";

beforeEach(() => resetItemIds());

function user(blocks: ChatItem["blocks"]): ChatItem {
  const item = emptyItem("user", blocks);
  item.done = true;
  return item;
}

describe("outlineEntries", () => {
  it("lists only user messages in transcript order", () => {
    const a = user([{ kind: "text", text: "first question", done: true }]);
    const b = emptyItem("assistant", [{ kind: "text", text: "answer", done: true }]);
    b.done = true;
    const c = user([{ kind: "text", text: "second", done: true }]);
    const entries = outlineEntries([a, b, c]);
    expect(entries.map((e) => e.text)).toEqual(["first question", "second"]);
    expect(entries.map((e) => e.itemId)).toEqual([a.id, c.id]);
  });

  it("collapses whitespace to a single line", () => {
    const entries = outlineEntries([user([{ kind: "text", text: "hello\n  world\tagain", done: true }])]);
    expect(entries[0].text).toBe("hello world again");
  });

  it("shows a placeholder for image-only messages but keeps them jumpable", () => {
    const img = user([{ kind: "image", data: "abc", mimeType: "image/png" }]);
    const entries = outlineEntries([img]);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe(OUTLINE_IMAGE_PLACEHOLDER);
    expect(entries[0].itemId).toBe(img.id);
  });

  it("skips ephemeral steer traces", () => {
    const steer = user([{ kind: "text", text: "插话", done: true }]);
    steer.ephemeral = true;
    steer.steer = true;
    const normal = user([{ kind: "text", text: "real", done: true }]);
    expect(outlineEntries([steer, normal])).toHaveLength(1);
  });
});
