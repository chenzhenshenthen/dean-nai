"use client";

import { useMemo } from "react";
import { motion } from "motion/react";
import { Loader2, Sparkles, PanelLeftClose, Square } from "lucide-react";
import { toast } from "sonner";
import { useStore, type SettingsTab } from "@/lib/store";
import { spring } from "@/lib/motion";
import { DEFAULT_SETTINGS, type GenerationSettings } from "@/lib/nai/types";
import { estimateGenerationCost, modelLabel } from "@/lib/nai/models";
import { useAppPreferences } from "@/lib/use-app-preferences";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { PanelHeader } from "@/components/ui/panel-header";
import { BasicTab } from "./basic-tab";
import { AdvancedTab } from "./advanced-tab";
import { CharactersTab } from "./characters-tab";
import { Switch } from "@/components/ui/switch";

/**
 * Cheap dirty check for the Reset affordance.
 *
 * The previous implementation JSON.stringify'd the whole settings object on every render, twice.
 * `vibe` and `directorReference` each carry multi-megabyte base64 reference images, so any render
 * triggered by typing, tab switches, or generation progress serialised megabytes of string data
 * on the main thread — the "every action pegs the CPU" cost. Reference content changes are
 * captured by their array length (adding/removing is the only path in, and restoreSettings always
 * replaces the array wholesale); everything else is cheap scalar comparison.
 */
function isSettingsDirty(s: GenerationSettings): boolean {
  const d = DEFAULT_SETTINGS;
  return (
    s.artistPrompt !== d.artistPrompt ||
    s.prompt !== d.prompt ||
    s.scenePrompt !== d.scenePrompt ||
    s.negativePrompt !== d.negativePrompt ||
    s.model !== d.model ||
    s.width !== d.width ||
    s.height !== d.height ||
    s.steps !== d.steps ||
    s.seed !== d.seed ||
    s.sampler !== d.sampler ||
    s.scale !== d.scale ||
    s.cfgRescale !== d.cfgRescale ||
    s.noiseSchedule !== d.noiseSchedule ||
    s.ucPreset !== d.ucPreset ||
    s.qualityToggle !== d.qualityToggle ||
    s.qualityTier !== d.qualityTier ||
    s.transparentBackground !== d.transparentBackground ||
    s.straightAlpha !== d.straightAlpha ||
    s.nSamples !== d.nSamples ||
    s.dynamicThresholding !== d.dynamicThresholding ||
    s.autoSmea !== d.autoSmea ||
    JSON.stringify(s.characters) !== JSON.stringify(d.characters) ||
    s.vibe.length !== d.vibe.length ||
    s.directorReference.length !== d.directorReference.length
  );
}

export function SettingsSidebar() {
  const activeTab = useStore((s) => s.activeTab);
  const setUI = useStore((s) => s.setUI);
  const generate = useStore((s) => s.generate);
  const cancelGenerate = useStore((s) => s.cancelGenerate);
  const isGenerating = useStore((s) => s.isGenerating);
  const abortRequested = useStore((s) => s.abortRequested);
  const canCancelGeneration = useStore((s) => s.canCancelGeneration);
  const streaming = useStore((s) => s.streamingBatch);
  const nSamples = useStore((s) => s.settings.nSamples);
  const characterCount = useStore((s) => s.settings.characters.filter((c) => c.enabled).length);
  const referenceCount = useStore((s) => s.settings.vibe.length + s.settings.directorReference.length);
  const settings = useStore((s) => s.settings);
  const resetSettings = useStore((s) => s.resetSettings);
  const accountStatus = useStore((s) => s.accountStatus);
  const { preferences, patch: patchPreferences } = useAppPreferences();
  // Reset only appears once there's something to reset — on a clean form it would be a control
  // that visibly does nothing.
  const isDirty = useMemo(() => isSettingsDirty(settings), [settings]);
  const detectedOpus = Boolean(accountStatus?.active && accountStatus.tier === 3);
  const useOpusPricing = detectedOpus || preferences.assumeOpusFreeImages;
  const estimatedAnlas = useMemo(
    () => estimateGenerationCost(settings, useOpusPricing, Boolean(accountStatus?.opusUsage?.isNegative)),
    [accountStatus?.opusUsage?.isNegative, settings, useOpusPricing],
  );

  // Badges announce state the tab is currently hiding — otherwise enabling three characters and
  // returning to Basic looks identical to a clean slate.
  const TABS: { value: SettingsTab; label: string; badge?: number }[] = [
    { value: "basic", label: "Basic" },
    { value: "advanced", label: "Advanced", badge: referenceCount },
    { value: "characters", label: "Characters", badge: characterCount },
  ];

  const done = streaming?.filter((t) => t.status === "done").length ?? 0;
  const meanProgress = streaming?.length ? streaming.reduce((a, t) => a + t.progress, 0) / streaming.length : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border-soft">
        <PanelHeader
          title="Composer"
          subtitle={`${modelLabel(settings.model, true)} · ${settings.width}×${settings.height} · ${settings.steps} steps`}
          leading={
            <IconButton
              label="Collapse settings"
              size="sm"
              title="Collapse settings — ["
              onClick={() => setUI({ settingsCollapsed: true })}
            >
              <PanelLeftClose />
            </IconButton>
          }
          actions={isDirty && !isGenerating ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-[12px] text-muted"
              title="Reset every setting to its default"
              onClick={() => {
                const prev = settings;
                resetSettings();
                toast("Settings reset", {
                  duration: 6000,
                  action: { label: "Undo", onClick: () => useStore.setState({ settings: prev }) },
                });
              }}
            >
              Reset
            </Button>
          ) : undefined}
        />
        <div className="px-3 pb-3">
        <Segmented
          asTabs
          aria-label="Settings sections"
          options={TABS}
          value={activeTab}
          onValueChange={(v) => setUI({ activeTab: v })}
          className="flex w-full"
        />
        </div>
      </div>

      {/* Keyed so switching tabs cross-fades instead of hard-swapping a 360px column in one frame.
          Plain opacity — these are peer panels, not a sequence, so a slide would imply order. */}
      <div
        key={activeTab}
        role="tabpanel"
        aria-label={TABS.find((t) => t.value === activeTab)?.label}
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ animation: "fadeIn var(--duration-fast) var(--ease-out)" }}
      >
        {activeTab === "basic" && <BasicTab />}
        {activeTab === "advanced" && <AdvancedTab />}
        {activeTab === "characters" && <CharactersTab />}
      </div>

      <div className="shrink-0 border-t border-border-soft bg-surface p-3 shadow-[0_-10px_28px_-20px_rgba(0,0,0,0.7)]">
        {!isGenerating && <div className="mb-2 flex items-center gap-2 px-1 text-[11px] text-muted"><span>预计消耗</span><span className="font-[family-name:var(--font-mono)] tabular-nums">{estimatedAnlas} Anlas</span><label className="ml-auto flex cursor-pointer items-center gap-1.5" title={detectedOpus ? "账号已识别为 Opus" : "手动按会员小图免费条件估算"}><Switch checked={useOpusPricing} disabled={detectedOpus} onCheckedChange={(assumeOpusFreeImages) => patchPreferences({ assumeOpusFreeImages })} /><span>会员小图免费</span></label></div>}
        {isGenerating ? (
          <div className="flex items-center gap-2">
            {/* The percentage was text-only. A determinate fill behind it turns the primary slot
                into the progress indicator itself, so progress is readable peripherally without
                parsing two numbers. */}
            <div className="relative flex h-12 min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-[var(--radius-button)] bg-surface-2 px-3.5">
              {canCancelGeneration && (
                <motion.span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-accent/18"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.round(meanProgress * 100)}%` }}
                  transition={spring.soft}
                />
              )}
              <Loader2 className="motion-keep relative z-10 size-4 shrink-0 animate-spin text-accent" />
              <span className="relative z-10 truncate text-[13.5px] font-semibold text-fg">
                {abortRequested ? "Stopping…" : canCancelGeneration ? "Generating" : "Generating with V3"}
                <span className="ml-1.5 font-[family-name:var(--font-mono)] text-[12.5px] tabular-nums text-muted">
                  {canCancelGeneration
                    ? `${done}/${streaming?.length ?? nSamples} · ${Math.round(meanProgress * 100)}%`
                    : "final image only"}
                </span>
              </span>
            </div>
            {canCancelGeneration && (
              <Button
                variant="outline"
                size="lg"
                className="h-12 shrink-0 px-4"
                disabled={abortRequested}
                onClick={cancelGenerate}
                title="Stop — finished images are kept"
              >
                <Square className="size-4" /> Stop
              </Button>
            )}
          </div>
        ) : (
          <Button
            className="h-12 w-full text-[15px]"
            onClick={() => void generate()}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            title="Generate — ⌘↵"
          >
            <Sparkles className="size-[18px]" /> Generate{nSamples > 1 ? ` · ${nSamples}` : ""}
          </Button>
        )}
      </div>
    </div>
  );
}
