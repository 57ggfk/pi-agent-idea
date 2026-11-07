import { describe, expect, test } from "vitest";
import { emptyItem } from "../store/types";
import type { ChatItem } from "../store/types";
import { clampScale, collectImages, imageSrc, scaleByWheel, ZOOM_MAX, ZOOM_MIN } from "./imagePreview";

/** T135/T136 (012 US7): the image collection walks one session's items in
 *  transcript order and skips everything that is not a usable image block. */

const userWith = (...blocks: ChatItem["blocks"]): ChatItem => {
  const item = emptyItem("user", blocks);
  item.done = true;
  return item;
};

const assistantWith = (...blocks: ChatItem["blocks"]): ChatItem => {
  const item = emptyItem("assistant", blocks);
  item.done = true;
  return item;
};

describe("collectImages", () => {
  test("an empty session yields nothing", () => {
    expect(collectImages([])).toEqual([]);
  });

  test("a single image is found with its source and order", () => {
    const items = [userWith({ kind: "image", data: "AA", mimeType: "image/png" })];
    const images = collectImages(items);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ itemId: items[0].id, blockIndex: 0 });
    expect(images[0].src).toBe("data:image/png;base64,AA");
  });

  test("mixed text+image keeps transcript order across items", () => {
    const items = [
      userWith({ kind: "image", data: "AA", mimeType: "image/png" }),
      assistantWith(
        { kind: "text", text: "here is the render", done: true },
        { kind: "image", data: "BB", mimeType: "image/jpeg" },
      ),
      userWith({ kind: "text", text: "thanks", done: true }),
      userWith({ kind: "image", data: "CC", mimeType: "image/png" }),
    ];
    const images = collectImages(items);
    expect(images.map((i) => i.src)).toEqual([
      "data:image/png;base64,AA",
      "data:image/jpeg;base64,BB",
      "data:image/png;base64,CC",
    ]);
    expect(images.map((i) => i.label)).toEqual(["user #1", "pi #2", "user #3"]);
  });

  test("empty data and thinking/toolcall blocks are skipped", () => {
    const items = [
      userWith(
        { kind: "thinking", text: "hmm", done: true },
        { kind: "image", data: "", mimeType: "image/png" },
        { kind: "image", data: "DD", mimeType: "image/png" },
      ),
    ];
    expect(collectImages(items)).toHaveLength(1);
  });
});

describe("imageSrc", () => {
  test("data: URLs pass through; bare base64 gets the mime prefix; missing mime defaults to png", () => {
    expect(imageSrc("data:image/webp;base64,AA", "image/webp")).toBe("data:image/webp;base64,AA");
    expect(imageSrc("AA", "image/jpeg")).toBe("data:image/jpeg;base64,AA");
    expect(imageSrc("AA", "")).toBe("data:image/png;base64,AA");
  });
});

describe("zoom", () => {
  test("wheel steps multiply and quantize; out-of-range values clamp (T136)", () => {
    expect(scaleByWheel(1, -100)).toBe(1.1);
    expect(scaleByWheel(1, 100)).toBeCloseTo(0.91, 2);
    expect(scaleByWheel(100, -100)).toBe(ZOOM_MAX);
    expect(scaleByWheel(0.01, 100)).toBe(ZOOM_MIN);
    expect(clampScale(Number.NaN)).toBe(1);
  });
});
