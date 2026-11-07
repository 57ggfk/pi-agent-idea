import type { ChatItem } from "../store/types";

/**
 * Image-preview model (012 US7, T135/T136) — pure functions, unit-tested
 * without a DOM.
 */

export interface PreviewImage {
  /** Stable identity: which item / block the image came from. */
  itemId: number;
  blockIndex: number;
  /** Display name (best effort): the message role + block position. */
  label: string;
  /** Decoded data URL — see imageSrc. */
  src: string;
}

/**
 * The images of ONE session, in transcript order (Q4 default scope: the
 * current session only). Both wire shapes from `messageBlocks` are already
 * normalized by the store, so every image block carries bare base64 here.
 */
export function collectImages(items: ChatItem[]): PreviewImage[] {
  const out: PreviewImage[] = [];
  items.forEach((item) => {
    item.blocks.forEach((block, blockIndex) => {
      if (block.kind !== "image" || !block.data) return;
      out.push({
        itemId: item.id,
        blockIndex,
        label: `${item.role === "user" ? "user" : "pi"} #${out.length + 1}`,
        src: imageSrc(block.data, block.mimeType),
      });
    });
  });
  return out;
}

/** `data:` URLs pass through; bare base64 gets a MIME prefix (types.ts 226). */
export function imageSrc(data: string, mimeType: string): string {
  return data.startsWith("data:") ? data : `data:${mimeType || "image/png"};base64,${data}`;
}

/** Zoom limits (T136): quantized wheel steps between 0.25× and 6×. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 6;

export function clampScale(scale: number): number {
  if (Number.isNaN(scale)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/** One wheel notch (±100 deltaY) multiplies by ~1.1, quantized to 2 decimals. */
export function scaleByWheel(scale: number, deltaY: number): number {
  const factor = deltaY > 0 ? 1 / 1.1 : 1.1;
  return Math.round(clampScale(scale * factor) * 100) / 100;
}

/** The CSS transform for the current zoom/pan state. */
export function imageTransform(scale: number, offsetX: number, offsetY: number): string {
  return `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}
