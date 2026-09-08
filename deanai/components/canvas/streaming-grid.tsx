"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { useStore, type StreamTile } from "@/lib/store";
import { listContainer, listItem, spring } from "@/lib/motion";
import { DEFAULT_CONNECTION } from "@/lib/nai/client";
import { ProgressRing } from "@/components/ui/progress-ring";
import { cn } from "@/lib/utils";

function gridCols(n: number) {
  if (n <= 1) return "grid-cols-1";
  if (n <= 4) return "grid-cols-2";
  if (n <= 9) return "grid-cols-3";
  return "grid-cols-4";
}

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** Longest edge for the ambient backdrop thumbnail. */
const BACKDROP_MAX = 256;

/**
 * Downscale a data-URL image to a ~256px JPEG thumbnail.
 *
 * The streaming backdrop is the full-resolution image the user was looking at when they pressed
 * Generate, rendered behind the tiles with `blur-lg` (16px) for the whole run. A static 832x1216
 * image under a heavy blur is the dominant CPU cost during the "waiting for first frame" window —
 * the browser has to decode + blur it every time the layer re-composites (which the shimmer/spin
 * animations below force on every frame). The backdrop is ambient at 18% opacity behind a blur, so
 * a thumbnail is visually indistinguishable but costs a fraction of the pixels to blur.
 */
function downscaleDataUrl(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, BACKDROP_MAX / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(dataUrl);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/** Memoised downscale of the backdrop so it happens once per backdrop, not on every tile update. */
function useDownscaledBackdrop(backdrop?: string | null): string | null {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!backdrop) return;
    downscaleDataUrl(backdrop).then((d) => {
      if (!cancelled) setThumb(d);
    });
    return () => {
      cancelled = true;
    };
  }, [backdrop]);
  return backdrop ? thumb : null;
}

/** Ticks once a second while a run is in flight, so waits show elapsed time rather than a frozen ring. */
function useElapsed(startedAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt ? now - startedAt : 0;
}

/**
 * Status bar showing generation progress. Also isolated so its re-renders don't cascade to tiles.
 * Ticks every second (elapsed time), so the `elapsed > 15s` stall heuristic lives here instead of
 * the grid — the grid itself only re-renders when tiles actually change.
 */
const StatusBar = memo(function StatusBar({
  tiles,
  livePreview,
  stalled,
  isDirect,
  startedAt,
}: {
  tiles: StreamTile[];
  livePreview: boolean;
  stalled: boolean;
  isDirect: boolean;
  startedAt: number | null;
}) {
  const done = tiles.filter((t) => t.status === "done").length;
  const mean = tiles.length ? tiles.reduce((a, t) => a + t.progress, 0) / tiles.length : 0;
  // Retries on 429/5xx use a 2s base delay, so "queued" can legitimately last tens of seconds.
  // Only after 15s of nothing should we hint the host may be busy.
  const elapsed = useElapsed(startedAt);
  const showStalled = stalled && elapsed > 15000;

  return (
    <div className="relative mb-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[12.5px]">
      <span className="font-semibold text-fg">
        {!livePreview
          ? "Generating with V3 — preview arrives when complete"
          : showStalled
            ? `Still waiting — ${isDirect ? "NovelAI" : "the host"} may be busy`
            : done === tiles.length
              ? "Finishing up"
              : "Generating"}
      </span>
      <span className="font-[family-name:var(--font-mono)] text-[12px] tabular-nums text-muted">
        {livePreview ? `${done}/${tiles.length} · ${Math.round(mean * 100)}% · ` : `${tiles.length} final · `}
        {mmss(elapsed)}
      </span>
    </div>
  );
});

/**
 * A single streaming tile, memoised so updates to one tile don't force every other tile to
 * re-render. Compares by reference identity — when a tile's dataUrl changes, only that tile
 * re-renders.
 */
const StreamTileView = memo(function StreamTileView({
  tile,
  steps,
  width,
  height,
  maxBlur,
  livePreview,
}: {
  tile: StreamTile;
  steps: number;
  width: number;
  height: number;
  maxBlur: number;
  livePreview: boolean;
}) {
  return (
    <motion.div
      variants={listItem}
      // A finished sample gets one brief accent ring — in a 9-up grid the blur settling is
      // easy to miss, and this is the moment worth noticing. Animating `boxShadow` rather
      // than a class swap keeps it from fighting the border already on the element.
      animate={
        tile.status === "done"
          ? { boxShadow: ["0 0 0 0px var(--accent)", "0 0 0 2px var(--accent)", "0 0 0 0px transparent"] }
          : undefined
      }
      transition={tile.status === "done" ? { duration: 0.7, ease: "easeOut" } : spring.smooth}
      // The real target aspect, not a hardcoded 3:4 — a landscape batch used to preview in
      // portrait boxes and then reflow the moment it committed.
      style={{ aspectRatio: `${width} / ${height}` }}
      className="relative flex items-center justify-center overflow-hidden rounded-[var(--radius-card)] border border-border-soft bg-surface-2"
    >
      {tile.dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={tile.dataUrl}
          alt=""
          // THE SIGNATURE: blur radius is bound to denoise progress, so the picture pulls
          // into focus as the model resolves it rather than sitting behind a flat frost and
          // popping. `(1-p)^1.5` sits below linear throughout — composition becomes legible
          // early (so you can abort sooner) and the tail is gentle, so the tile settles
          // instead of lurching at the end.
          //
          // duration-fast, NOT duration-base: intermediates arrive ~200ms apart, so a 240ms
          // transition would never settle and the blur would permanently lag real progress.
          //
          // Under prefers-reduced-motion the global rule collapses the transition and the
          // blur steps instead of gliding. That is the correct degradation — the information
          // survives, the animation doesn't — so this deliberately does not opt out via
          // .motion-keep the way the spinner and shimmer do.
          className="h-full w-full object-cover transition-[filter] duration-fast ease-out"
          style={{
            filter:
              tile.status === "done"
                ? undefined
                : `blur(${((1 - tile.progress) ** 1.5 * maxBlur).toFixed(1)}px)`,
          }}
        />
      ) : (
        <div
          className="absolute inset-0 overflow-hidden"
          style={{
            background:
              "linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 50%, var(--surface-2) 75%)",
          }}
        >
          {/* Compositor-friendly sweep (see `shimmer-x`): a transform-animated overlay instead of
              `background-position`. Transform runs on the GPU, so the placeholder tile costs ~0
              main-thread CPU while it shakes during the "waiting for the first frame" window. */}
          <div
            className="motion-keep absolute inset-y-0 left-0 w-full"
            style={{
              background:
                "linear-gradient(90deg, transparent 30%, rgba(255,255,255,0.08) 50%, transparent 70%)",
              animation: "shimmer-x 2.6s linear infinite",
            }}
          />
        </div>
      )}
      {tile.status !== "done" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/25">
          {tile.status === "initializing" ? (
            <>
              {/* An indeterminate arc, not a 0/28 ring frozen over a shimmer — that was
                  indistinguishable from a dead request. */}
              <span
                className="motion-keep size-[26px] rounded-full border-2 border-white/25 border-t-accent"
                style={{ animation: "spin 1.6s linear infinite" }}
              />
              <span className="font-[family-name:var(--font-mono)] text-[11px] text-white/80">
                {livePreview ? "Queued" : "Waiting for final"}
              </span>
            </>
          ) : (
            <ProgressRing progress={tile.progress} size={52}>
              {tile.stepIndex}/{steps}
            </ProgressRing>
          )}
        </div>
      )}
    </motion.div>
  );
});

/** Live streaming previews — each sample denoises in place behind a progress ring. */
export function StreamingGrid({ tiles, backdrop }: { tiles: StreamTile[]; backdrop?: string | null }) {
  const steps = useStore((s) => s.settings.steps);
  const startedAt = useStore((s) => s.runStartedAt);
  const width = useStore((s) => s.settings.width);
  const height = useStore((s) => s.settings.height);
  const livePreview = useStore((s) => s.canCancelGeneration);
  // Don't attribute a stall to NovelAI when the user pointed the client at their own proxy.
  const isDirect = useStore((s) => (s.connection?.host ?? DEFAULT_CONNECTION.host) === DEFAULT_CONNECTION.host);
  // The backdrop is ambient (18% opacity behind a 16px blur), so a ~256px thumbnail is visually
  // equivalent but costs a fraction of the CPU to decode and blur during the whole run.
  const backdropThumb = useDownscaledBackdrop(backdrop);

  // Blur scales with tile size. A flat radius that reads as "resolving" on a single large tile
  // erases composition entirely across a 9-up grid — during exactly the window where the user is
  // deciding whether to hit Stop.
  const maxBlur = tiles.length <= 1 ? 14 : tiles.length <= 4 ? 9 : 6;

  // Retries on 429/5xx use a 2s base delay, so "queued" can legitimately last tens of seconds.
  const stalled = useMemo(
    () => livePreview && tiles.every((t) => t.status === "initializing"),
    [livePreview, tiles],
  );

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-auto p-3 sm:p-6">
      {/* The image you were looking at when you pressed Generate, held as ambient context so the
          stage never blanks mid-commit. Same treatment as the BatchView backdrop. Downscaled to a
          thumbnail: it sits behind a 16px blur at 18% opacity, so full resolution is pure waste. */}
      {backdropThumb && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={backdropThumb}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-[0.18] blur-lg"
        />
      )}

      <StatusBar
        tiles={tiles}
        livePreview={livePreview}
        stalled={stalled}
        isDirect={isDirect}
        startedAt={startedAt}
      />

      <motion.div
        className={cn("relative grid w-full max-w-4xl gap-2 sm:gap-4", gridCols(tiles.length))}
        variants={listContainer}
        initial="hidden"
        animate="show"
      >
        {tiles.map((t) => (
          <StreamTileView
            key={t.sampleIndex}
            tile={t}
            steps={steps}
            width={width}
            height={height}
            maxBlur={maxBlur}
            livePreview={livePreview}
          />
        ))}
      </motion.div>
    </div>
  );
}
