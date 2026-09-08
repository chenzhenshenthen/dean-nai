"use client";

import { Images, Loader2, PanelLeftOpen, Search, Settings2, Sparkles, Square } from "lucide-react";
import { AccountStatusMenu } from "./account-status-panel";
import { useStore } from "@/lib/store";
import { BrandLogo } from "./brand-logo";
import { ThemeControls } from "./theme-controls";
import { IconButton } from "./ui/icon-button";
import { focusRing } from "./ui/input";
import { cn } from "@/lib/utils";
import { DesktopFullscreenButton } from "./desktop-fullscreen-button";

export function SiteHeader() {
  const status = useStore((s) => s.connectionStatus);
  const isGenerating = useStore((s) => s.isGenerating);
  const imageCount = useStore((s) => s.images.length);
  const generate = useStore((s) => s.generate);
  const cancelGenerate = useStore((s) => s.cancelGenerate);
  const abortRequested = useStore((s) => s.abortRequested);
  const canCancelGeneration = useStore((s) => s.canCancelGeneration);
  const setUI = useStore((s) => s.setUI);
  const connected = status === "ok";

  const connectionLabel =
    status === "verifying" ? "正在验证" : status === "invalid" ? "重新连接" : connected ? "已连接" : "连接";

  return (
    <header className="relative z-40 flex h-14 shrink-0 items-center gap-2 border-b border-border-soft bg-surface/95 px-2.5 shadow-[0_1px_0_0_var(--border-soft)] backdrop-blur-xl sm:px-4">
      <IconButton
        label="打开设置"
        title="打开设置"
        onClick={() => setUI({ settingsCollapsed: false, galleryOpen: false })}
        className="xl:hidden"
      >
        <PanelLeftOpen />
      </IconButton>

      <div className={cn("flex min-w-0 items-center gap-2.5", process.env.NEXT_PUBLIC_LOCAL_DESKTOP === "1" && "hidden")}>
        <BrandLogo variant="mark" priority className="size-7 sm:hidden" />
        <BrandLogo priority className="hidden h-8 w-[120px] sm:inline-flex" />
      </div>

      {/* A hidden ⌘K is a shortcut only the people who already knew about it will find. This is the
          discoverable surface for it; on narrow screens it degrades to the icon alone. */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event("nya-command-palette"))}
        aria-label="打开命令搜索"
        aria-keyshortcuts="Meta+K Control+K"
        title="搜索命令或跳转 — Ctrl+K"
        className={cn(
          "group ml-3 flex h-9 items-center gap-2 rounded-[var(--radius-pill)] border border-border-soft bg-surface-2 px-2.5 text-muted",
          "transition-[background-color,color,border-color] duration-instant hover:border-border hover:bg-surface-3 hover:text-fg-2 md:w-56 md:px-3",
          focusRing,
          "focus-visible:ring-offset-surface",
        )}
      >
        <Search className="size-4 shrink-0" />
        <span className="hidden flex-1 text-left text-[12.5px] md:inline">搜索命令或跳转…</span>
        <kbd className="hidden shrink-0 rounded-[5px] border border-border-soft bg-surface px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[10px] text-muted md:block">
          Ctrl K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
        <DesktopFullscreenButton />
        <AccountStatusMenu />
        <button
          type="button"
          onClick={() => isGenerating ? cancelGenerate() : void generate()}
          disabled={abortRequested || (isGenerating && !canCancelGeneration)}
          aria-label={isGenerating ? (canCancelGeneration ? "停止生成" : "正在生成") : "生成"}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          title={isGenerating
            ? canCancelGeneration
              ? "停止生成——已完成图片会保留"
              : "V3 会在生成完成后返回最终图片"
            : "生成 — Ctrl+Enter"}
          className={cn(
            "inline-flex h-9 items-center justify-center gap-1.5 rounded-[9px] bg-accent px-2.5 text-[12.5px] font-bold text-on-accent shadow-[var(--glow-accent)]",
            "transition-[filter,transform] duration-fast ease-out hover:brightness-[1.07] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-70 xl:hidden",
            focusRing,
            "focus-visible:ring-offset-surface",
          )}
        >
          {isGenerating
            ? canCancelGeneration
              ? <Square className="size-3.5" />
              : <Loader2 className="motion-keep size-4 animate-spin" />
            : <Sparkles className="size-4" />}
          <span className="hidden sm:inline">
            {abortRequested ? "正在停止" : isGenerating ? (canCancelGeneration ? "停止" : "生成中") : "生成"}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setUI({ showConnect: true })}
          aria-label={connectionLabel}
          title={connectionLabel}
          className={cn(
            "flex h-9 items-center gap-2 rounded-[var(--radius-pill)] border border-border-soft bg-surface-2 px-2.5 text-[12.5px] font-medium text-fg-2 transition-colors duration-instant hover:bg-surface-3 hover:text-fg sm:px-3",
            focusRing,
            "focus-visible:ring-offset-surface",
          )}
        >
          <span
            className={cn(
              "size-2 rounded-full",
              status === "invalid" ? "bg-danger" : status === "verifying" ? "animate-pulse bg-warn" : connected ? "bg-ok" : "bg-warn",
            )}
            style={connected ? { boxShadow: "0 0 8px var(--ok)" } : undefined}
          />
          <span className="hidden sm:inline">{connectionLabel}</span>
        </button>
        <ThemeControls />
        {process.env.NEXT_PUBLIC_LOCAL_DESKTOP !== "1" && <a
          href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/settings/`}
          aria-label="打开完整设置"
          title="完整设置与便携资料"
          className={cn("grid size-9 place-items-center rounded-lg border border-border-soft bg-surface-2 text-muted hover:bg-surface-3 hover:text-fg", focusRing)}
        ><Settings2 className="size-4" /></a>}
        <IconButton
          label="打开生图历史"
          title="打开生图历史"
          onClick={() => setUI({ galleryOpen: true, settingsCollapsed: true })}
          className="relative xl:hidden"
        >
          <Images />
          {imageCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 font-[family-name:var(--font-mono)] text-[9px] font-bold text-on-accent">
              {imageCount > 99 ? "99+" : imageCount}
            </span>
          )}
        </IconButton>
      </div>
    </header>
  );
}
