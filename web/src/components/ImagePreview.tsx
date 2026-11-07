import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getBridge } from "../bridge";
import { usePiStore } from "../store/store";
import { collectImages, clampScale, imageTransform, scaleByWheel, ZOOM_MAX, ZOOM_MIN } from "../lib/imagePreview";
import { useT } from "../i18n/useT";
import Icon from "./Icon";

/**
 * Image preview modal (012 US7, T134–T138). Modeled on ConfirmDialog:
 * role="dialog" + aria-modal, Esc and mask-click close (clicking the image
 * itself does NOT), focus stays inside, and `onWheel preventDefault` keeps
 * the message list from scrolling under the zoom gesture. The transcript is
 * not re-rendered: the modal is a portal over it, so the list's scrollTop
 * never moves while the preview is open.
 *
 * Zoom: wheel steps and the +/- buttons move between 0.25× and 6×; dragging
 * pans; reset restores the initial fit. Multiple images switch with ←/→ and
 * the toolbar buttons, showing a "current/total" indicator.
 */
export default function ImagePreview() {
  const { t } = useT();
  const items = usePiStore((s) => s.items);
  const request = usePiStore((s) => s.imagePreview);
  const closeImagePreview = usePiStore((s) => s.closeImagePreview);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [saveNote, setSaveNote] = useState<{ ok: boolean; text: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);

  const images = useMemo(() => collectImages(items), [items]);

  // A click on a transcript thumbnail raises the request; the modal derives
  // its index from the same collection the navigation uses. The request is
  // applied ONCE per click: `items` keeps changing while the assistant
  // streams, and re-deriving would yank the user back to the clicked image
  // mid-navigation.
  const appliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!request) {
      appliedRef.current = null;
      return;
    }
    const key = `${request.itemId}:${request.blockIndex}`;
    if (appliedRef.current === key) return;
    const idx = images.findIndex((i) => i.itemId === request.itemId && i.blockIndex === request.blockIndex);
    if (idx >= 0) {
      appliedRef.current = key;
      setPreviewIndex(idx);
      setScale(1);
      setOffset({ x: 0, y: 0 });
      setSaveNote(null);
    }
  }, [request, images]);

  const open = previewIndex != null && previewIndex < images.length;

  const close = useCallback(() => {
    setPreviewIndex(null);
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setSaveNote(null);
    closeImagePreview();
  }, [closeImagePreview]);

  const step = useCallback(
    (delta: number) => {
      setPreviewIndex((current) => {
        if (current == null) return current;
        const next = current + delta;
        return next < 0 || next >= images.length ? current : next;
      });
      setScale(1);
      setOffset({ x: 0, y: 0 });
      setSaveNote(null);
    },
    [images.length],
  );

  // Esc closes; ←/→ navigate; focus lands inside and stays inside (tab trap).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      }
    };
    // Capture phase, like ConfirmDialog: nothing else may consume these.
    document.addEventListener("keydown", onKeyDown, true);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, close, step]);

  // Tab trap: the modal is a portal, so the rest of the app must be unreachable.
  useEffect(() => {
    if (!open) return;
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>("button");
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onTab, true);
    return () => document.removeEventListener("keydown", onTab, true);
  }, [open]);

  if (!open) return null;
  const image = images[previewIndex!];

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => scaleByWheel(s, e.deltaY));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, baseX: offset.x, baseY: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.baseX + (e.clientX - d.x), y: d.baseY + (e.clientY - d.y) });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const zoomStep = (delta: number) => {
    setScale((s) => clampScale(s + delta));
  };

  const reset = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  const saveImage = async () => {
    setSaveNote(null);
    try {
      const api = (await getBridge()) as unknown as {
        request: (m: string, p?: unknown) => Promise<{ ok: boolean; path?: string; cancelled?: boolean; error?: string }>;
      };
      const res = await api.request("ide.saveImage", {
        data: image.src,
        suggestedName: `pi-image-${previewIndex! + 1}.png`,
      });
      if (res.ok && res.path) {
        setSaveNote({ ok: true, text: t("image.savedTo", { path: res.path }) });
      } else if (res.cancelled) {
        setSaveNote({ ok: false, text: t("image.saveCancelled") });
      } else {
        setSaveNote({ ok: false, text: res.error ?? t("image.saveFailed") });
      }
    } catch (e) {
      setSaveNote({ ok: false, text: (e as Error).message });
    }
  };

  const copyImage = async () => {
    setSaveNote(null);
    try {
      const api = (await getBridge()) as unknown as {
        request: (m: string, p?: unknown) => Promise<{ ok: boolean; error?: string }>;
      };
      const res = await api.request("ide.copyImage", { data: image.src });
      if (res.ok) {
        setSaveNote({ ok: true, text: t("image.copied") });
      } else {
        setSaveNote({ ok: false, text: res.error ?? t("image.copyFailed") });
      }
    } catch (e) {
      setSaveNote({ ok: false, text: (e as Error).message });
    }
  };

  return createPortal(
    <div
      className="image-preview-scrim"
      data-testid="image-preview"
      onClick={() => close()}
      onWheel={onWheel}
      role="presentation"
    >
      <div
        className="image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("image.aria", { index: previewIndex! + 1, total: images.length })}
        data-testid="image-preview-dialog"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="image-preview-bar">
          <span className="image-preview-count" data-testid="image-preview-count">
            {t("image.counter", { index: previewIndex! + 1, total: images.length })} · {image.label}
          </span>
          <span className="spacer" />
          <button type="button" className="icon-btn" data-testid="image-zoom-out" aria-label={t("image.zoomOut")} onClick={() => zoomStep(-0.25)} disabled={scale <= ZOOM_MIN}>
            <Icon name="zoom-out" />
          </button>
          <span className="image-preview-scale mono" data-testid="image-preview-scale">{Math.round(scale * 100)}%</span>
          <button type="button" className="icon-btn" data-testid="image-zoom-in" aria-label={t("image.zoomIn")} onClick={() => zoomStep(0.25)} disabled={scale >= ZOOM_MAX}>
            <Icon name="zoom-in" />
          </button>
          <button type="button" className="icon-btn" data-testid="image-reset" aria-label={t("image.reset")} onClick={reset}>
            <Icon name="refresh" />
          </button>
          <button type="button" className="btn" data-testid="image-copy" onClick={() => void copyImage()}>
            {t("image.copy")}
          </button>
          <button type="button" className="btn" data-testid="image-save" onClick={() => void saveImage()}>
            {t("image.save")}
          </button>
          <button type="button" className="icon-btn" data-testid="image-preview-close" aria-label={t("common.close")} onClick={() => close()}>
            <Icon name="x" />
          </button>
        </div>
        <div className="image-preview-stage">
          <button
            type="button"
            className="image-preview-nav"
            data-testid="image-prev"
            aria-label={t("image.prev")}
            onClick={() => step(-1)}
            disabled={previewIndex! === 0}
          >
            <Icon name="chev-left" />
          </button>
          <img
            className="image-preview-img"
            data-testid="image-preview-img"
            src={image.src}
            alt={image.label}
            draggable={false}
            style={{ transform: imageTransform(scale, offset.x, offset.y), cursor: "grab" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={reset}
          />
          <button
            type="button"
            className="image-preview-nav"
            data-testid="image-next"
            aria-label={t("image.next")}
            onClick={() => step(1)}
            disabled={previewIndex! === images.length - 1}
          >
            <Icon name="chev-right" />
          </button>
        </div>
        {saveNote ? (
          <div
            className={`panel-note ${saveNote.ok ? "" : "image-preview-error"}`}
            data-testid={saveNote.ok ? "image-result-ok" : "image-result-fail"}
          >
            {saveNote.text}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
