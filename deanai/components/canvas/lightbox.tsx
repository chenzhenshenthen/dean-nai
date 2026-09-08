"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download, RotateCcw, Maximize2, Share2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { copyImageWithoutMetadata, downloadDataUrl } from "@/lib/image-actions";
import { useFocusTrap, useDelayedUnmount } from "@/lib/use-overlay";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function Lightbox() {
  const batch = useStore((s) => s.selectedBatch);
  const focusedIndex = useStore((s) => s.focusedIndex);
  const setUI = useStore((s) => s.setUI);
  const restoreSettings = useStore((s) => s.restoreSettings);
  const selectImage = useStore((s) => s.selectImage);
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);

  const open = focusedIndex !== null && !!batch && focusedIndex < batch.length;
  const mounted = useDelayedUnmount(open, 160);
  const trapRef = useFocusTrap<HTMLDivElement>(open);

  const availableWidth = Math.max(1, viewport.width - 32);
  const availableHeight = Math.max(1, viewport.height - 32);
  const fitRatio = natural.width && natural.height
    ? Math.min(1, availableWidth / natural.width, availableHeight / natural.height)
    : 1;
  const fitWidth = Math.max(1, natural.width * fitRatio);
  const fitHeight = Math.max(1, natural.height * fitRatio);
  const scaledWidth = fitWidth * zoom;
  const scaledHeight = fitHeight * zoom;
  const surfaceWidth = Math.max(viewport.width, scaledWidth + 32);
  const surfaceHeight = Math.max(viewport.height, scaledHeight + 32);
  const imageLeft = (surfaceWidth - scaledWidth) / 2;
  const imageTop = (surfaceHeight - scaledHeight) / 2;

  const close = () => {
    setZoom(1);
    setNatural({ width: 0, height: 0 });
    setUI({ focusedIndex: null });
  };

  const nav = (delta: number) => {
    if (!batch || focusedIndex === null) return;
    const nextIndex = Math.min(batch.length - 1, Math.max(0, focusedIndex + delta));
    setZoom(1);
    setNatural({ width: 0, height: 0 });
    setUI({ focusedIndex: nextIndex });
    if (nextIndex !== focusedIndex) selectImage(batch[nextIndex], true);
  };

  const applyZoom = useCallback((requested: number, clientX?: number, clientY?: number) => {
    const element = viewportRef.current;
    if (!element || !fitWidth || !fitHeight) {
      setZoom(clampZoom(requested));
      return;
    }
    const next = clampZoom(requested);
    const rect = element.getBoundingClientRect();
    const focalX = clientX === undefined ? element.clientWidth / 2 : clientX - rect.left;
    const focalY = clientY === undefined ? element.clientHeight / 2 : clientY - rect.top;
    const oldImageX = (element.scrollLeft + focalX - imageLeft) / Math.max(1, scaledWidth);
    const oldImageY = (element.scrollTop + focalY - imageTop) / Math.max(1, scaledHeight);
    const nextScaledWidth = fitWidth * next;
    const nextScaledHeight = fitHeight * next;
    const nextSurfaceWidth = Math.max(viewport.width, nextScaledWidth + 32);
    const nextSurfaceHeight = Math.max(viewport.height, nextScaledHeight + 32);
    const nextLeft = (nextSurfaceWidth - nextScaledWidth) / 2;
    const nextTop = (nextSurfaceHeight - nextScaledHeight) / 2;
    setZoom(next);
    requestAnimationFrame(() => {
      element.scrollLeft = nextLeft + oldImageX * nextScaledWidth - focalX;
      element.scrollTop = nextTop + oldImageY * nextScaledHeight - focalY;
    });
  }, [fitHeight, fitWidth, imageLeft, imageTop, scaledHeight, scaledWidth, viewport.height, viewport.width]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !open) return;
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowLeft") nav(-1);
      if (event.key === "ArrowRight") nav(1);
      if (event.key === "+" || event.key === "=") applyZoom(zoom + 0.25);
      if (event.key === "-") applyZoom(zoom - 0.25);
      if (event.key === "0") applyZoom(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [applyZoom, batch, focusedIndex, open, zoom]);

  if (!mounted || typeof document === "undefined" || !batch) return null;
  const idx = Math.min(focusedIndex ?? 0, batch.length - 1);
  const img = batch[idx];
  if (!img) return null;

  return createPortal(
    <div
      ref={trapRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Image ${idx + 1} of ${batch.length}, seed ${img.seed}`}
      className={cn(
        "fixed inset-0 z-50 flex flex-col bg-black/90 outline-none transition-opacity",
        open ? "opacity-100 duration-base ease-out" : "opacity-0 duration-fast ease-in",
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-3 text-white">
        <span className="font-[family-name:var(--font-mono)] text-[12px] text-white/70">
          {idx + 1} / {batch.length} · seed {img.seed}
        </span>
        <div className="flex items-center gap-1">
          <span className="min-w-12 text-center text-[11px] tabular-nums text-white/65">{Math.round(zoom * 100)}%</span>
          <IconButton variant="lightbox" label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => applyZoom(zoom - 0.25)}><ZoomOut /></IconButton>
          <IconButton variant="lightbox" label="Fit image" disabled={zoom === 1} onClick={() => applyZoom(1)}><Maximize2 /></IconButton>
          <IconButton variant="lightbox" label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => applyZoom(zoom + 0.25)}><ZoomIn /></IconButton>
          <IconButton variant="lightbox" label="Reuse settings" onClick={() => restoreSettings(img.settings)}><RotateCcw /></IconButton>
          <IconButton variant="lightbox" label="Download" onClick={() => downloadDataUrl(img.dataUrl, img.filename, img)}><Download /></IconButton>
          <IconButton variant="lightbox" label="复制无元数据图片" title="复制无元数据图片（PNG）" onClick={() => copyImageWithoutMetadata(img.dataUrl)}><Share2 /></IconButton>
          <IconButton variant="lightbox" label="Close" onClick={close}><X /></IconButton>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={viewportRef}
          className={cn("absolute inset-0 overscroll-contain", zoom > 1 ? "cursor-grab overflow-auto active:cursor-grabbing" : "cursor-default overflow-hidden")}
          onWheel={(event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            applyZoom(zoom * (event.deltaY > 0 ? 0.88 : 1.12), event.clientX, event.clientY);
          }}
          onDoubleClick={(event) => applyZoom(zoom === 1 ? 2 : 1, event.clientX, event.clientY)}
          onPointerDown={(event) => {
            if (zoom <= 1 || event.button !== 0) return;
            const element = viewportRef.current;
            if (!element) return;
            dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
            element.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            const element = viewportRef.current;
            if (!drag || !element || drag.id !== event.pointerId) return;
            element.scrollLeft = drag.left - (event.clientX - drag.x);
            element.scrollTop = drag.top - (event.clientY - drag.y);
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.id === event.pointerId) dragRef.current = null;
          }}
          onPointerCancel={() => { dragRef.current = null; }}
        >
          <div className="relative" style={{ width: surfaceWidth, height: surfaceHeight }}>
            <img
              src={img.dataUrl}
              alt=""
              draggable={false}
              onLoad={(event) => {
                const element = event.currentTarget;
                setNatural({ width: element.naturalWidth, height: element.naturalHeight });
                setZoom(1);
                requestAnimationFrame(() => {
                  const view = viewportRef.current;
                  if (view) {
                    view.scrollLeft = 0;
                    view.scrollTop = 0;
                  }
                });
              }}
              className="absolute select-none object-contain shadow-2xl"
              style={{ left: imageLeft, top: imageTop, width: scaledWidth, height: scaledHeight }}
            />
          </div>
        </div>

        {batch.length > 1 && <IconButton variant="lightbox" size="lg" label="Previous" disabled={idx === 0} onClick={() => nav(-1)} className="absolute left-3 top-1/2 z-10 -translate-y-1/2"><ChevronLeft /></IconButton>}
        {batch.length > 1 && <IconButton variant="lightbox" size="lg" label="Next" disabled={idx === batch.length - 1} onClick={() => nav(1)} className="absolute right-3 top-1/2 z-10 -translate-y-1/2"><ChevronRight /></IconButton>}
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] text-white/65">
          Ctrl + 滚轮缩放 · 双击切换 · 放大后拖动
        </div>
      </div>
    </div>,
    document.body,
  );
}
