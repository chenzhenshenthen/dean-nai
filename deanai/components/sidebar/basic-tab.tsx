"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import {
  MODEL_OPTIONS,
  SIZE_TIERS,
  presetDims,
  tierAspectForSize,
  aspectsForTier,
  sizeSummary,
  defaultModelTuning,
  loadModelTuning,
  saveModelTuning,
} from "@/lib/nai/models";
import { Field, Section } from "./field";
import { TagTextarea } from "./tag-textarea";
import { AspectLock, DimensionInput } from "./dimension-input";
import { Select } from "@/components/ui/select";
import { Segmented } from "@/components/ui/segmented";
import { PromptLibrary } from "@/components/prompt-library";
import { IconButton } from "@/components/ui/icon-button";
import { BookPlus, BookUp, Dices } from "lucide-react";
import { openLibraryDraft } from "@/lib/library-transfer";
import { drawRandomLibraryEntry } from "@/lib/random-library";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAppPreferences } from "@/lib/use-app-preferences";
import { AutomaticGenerationStatus } from "@/components/automatic-generation-status";

const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const scaleTo = (next: number, previous: number, other: number) =>
  Math.min(2048, Math.max(64, Math.round((other * (next / previous)) / 64) * 64));

export function BasicTab() {
  const settings = useStore((state) => state.settings);
  const patch = useStore((state) => state.patchSettings);
  const selectedImage = useStore((state) => state.selectedImage);
  const [tier, aspect] = tierAspectForSize(settings.width, settings.height);
  const [linked, setLinked] = useState(false);
  const [randomBusy, setRandomBusy] = useState<"artist" | "prompt" | null>(null);
  const gachaMode = useStore((state) => state.gachaMode);
  const setGachaMode = useStore((state) => state.setGachaMode);
  const { preferences } = useAppPreferences();
  const lastPreset = useRef({ width: settings.width, height: settings.height });

  useEffect(() => {
    if (tier !== null) lastPreset.current = { width: settings.width, height: settings.height };
  }, [tier, settings.width, settings.height]);

  const setPreset = (nextTier: string, nextAspect: string) => {
    const preset =
      presetDims(nextTier, nextAspect) ??
      presetDims(nextTier, "portrait") ??
      presetDims("normal", nextAspect);
    if (preset) patch({ width: preset.w, height: preset.h });
  };

  const drawRandom = async (kind: "artist" | "prompt") => {
    if (randomBusy) return;
    setRandomBusy(kind);
    try {
      const entry = await drawRandomLibraryEntry(kind);
      patch(kind === "artist"
        ? { artistPrompt: entry.content.trim(), artistPromptName: entry.title.trim() }
        : { scenePrompt: entry.content.trim(), scenePromptName: entry.title.trim() });
    } catch (error) {
      toast.error(`随机选择失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRandomBusy(null);
    }
  };

  return (
    <>
      <Section title="Model">
        <Select value={settings.model} onChange={(event) => {
          const model = event.target.value as typeof settings.model;
          if (model === settings.model) return;
          saveModelTuning(settings);
          const remembered = loadModelTuning(model);
          patch({
            model,
            ...(remembered ?? defaultModelTuning(model)),
          });
        }}>
          {MODEL_OPTIONS.map((model) => (
            <option key={model.value} value={model.value}>{model.label}</option>
          ))}
        </Select>
      </Section>

      <Section title="Prompt">
        <Field
          label="画师串"
          htmlFor="artist-prompt"
          right={
            <div className="flex items-center gap-1">
              <IconButton
                size="sm"
                variant="subtle"
                className="size-7"
                label="将当前画师串和负面提示词一起保存到资料库"
                disabled={!settings.artistPrompt.trim() || !settings.negativePrompt.trim()}
                onClick={() => openLibraryDraft(
                  "artist",
                  settings.artistPrompt,
                  selectedImage,
                  settings.negativePrompt,
                )}
              >
                <BookPlus />
              </IconButton>
              <IconButton
                size="sm"
                variant="subtle"
                className="size-7"
                label="按设置随机一个画师串"
                disabled={Boolean(randomBusy)}
                onClick={() => void drawRandom("artist")}
              >
                <Dices className={randomBusy === "artist" ? "animate-spin" : undefined} />
              </IconButton>
              <PromptLibrary initialKind="artist" compact />
              <IconButton
                size="sm"
                variant="subtle"
                className="size-7"
                label="仅将当前画师串保存到资料库"
                disabled={!settings.artistPrompt.trim()}
                onClick={() => openLibraryDraft("artist", settings.artistPrompt, selectedImage)}
              >
                <BookUp />
              </IconButton>
            </div>
          }
        >
          <TagTextarea
            id="artist-prompt"
            aria-label="画师串"
            placeholder="artist tags, style mix…"
            value={settings.artistPrompt}
            onChange={(artistPrompt) => patch({ artistPrompt })}
          />
        </Field>
        <Field label="待用" htmlFor="prompt">
          <TagTextarea
            id="prompt"
            aria-label="待用提示词"
            placeholder="角色、动作、服装及其他待用提示词…"
            value={settings.prompt}
            onChange={(prompt) => patch({ prompt })}
          />
        </Field>
        <Field
          label="场景提示词"
          htmlFor="scene-prompt"
          right={
            <div className="flex items-center gap-1">
              <IconButton
                size="sm"
                variant="subtle"
                className="size-7"
                label="按设置随机一个场景提示词"
                disabled={Boolean(randomBusy)}
                onClick={() => void drawRandom("prompt")}
              >
                <Dices className={randomBusy === "prompt" ? "animate-spin" : undefined} />
              </IconButton>
              <PromptLibrary initialKind="prompt" compact />
              <IconButton
                size="sm"
                variant="subtle"
                className="size-7"
                label="将当前场景提示词保存到资料库"
                disabled={!settings.scenePrompt.trim()}
                onClick={() => openLibraryDraft("prompt", settings.scenePrompt, selectedImage)}
              >
                <BookUp />
              </IconButton>
            </div>
          }
        >
          <TagTextarea
            id="scene-prompt"
            aria-label="场景提示词"
            placeholder="环境、构图、光照、氛围…"
            value={settings.scenePrompt}
            onChange={(scenePrompt) => patch({ scenePrompt })}
          />
        </Field>
        <Field label="负面提示词" htmlFor="uc">
          <TagTextarea
            id="uc"
            className="min-h-[64px]"
            placeholder="lowres, bad anatomy, worst quality…"
            value={settings.negativePrompt}
            onChange={(negativePrompt) => patch({ negativePrompt })}
          />
        </Field>
      </Section>

      <Section title="Resolution">
        <div className="mb-3 flex flex-col gap-2">
          <Segmented
            className="w-full"
            aria-label="Aspect ratio"
            options={aspectsForTier(tier ?? "normal").map((item) => ({ value: item as string, label: cap(item) }))}
            value={aspect ?? ""}
            onValueChange={(nextAspect) => setPreset(tier ?? "normal", nextAspect)}
          />
          <Segmented
            className="w-full"
            aria-label="Size"
            options={[
              ...SIZE_TIERS.map((item) => ({ value: item as string, label: cap(item) })),
              ...(tier === null ? [{ value: "custom", label: "Custom" }] : []),
            ]}
            value={tier ?? "custom"}
            onValueChange={(nextTier) => {
              if (nextTier === "custom") {
                patch(lastPreset.current);
                return;
              }
              setPreset(nextTier, aspect ?? "portrait");
            }}
          />
        </div>
        <div className="flex items-end gap-2">
          <DimensionInput
            id="w"
            label="Width"
            min={64}
            max={2048}
            step={64}
            value={settings.width}
            onCommit={(width) => patch(linked ? { width, height: scaleTo(width, settings.width, settings.height) } : { width })}
          />
          <AspectLock locked={linked} onToggle={() => setLinked((value) => !value)} />
          <DimensionInput
            id="h"
            label="Height"
            min={64}
            max={2048}
            step={64}
            value={settings.height}
            onCommit={(height) => patch(linked ? { height, width: scaleTo(height, settings.height, settings.width) } : { height })}
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span aria-hidden className="flex h-6 w-10 shrink-0 items-center justify-center rounded-[5px] border border-border-soft bg-surface-2">
            <span
              className="rounded-[2px] bg-accent/70 transition-[width,height] duration-base ease-out"
              style={{
                width: `${Math.max(10, (settings.width >= settings.height ? 1 : settings.width / settings.height) * 20)}px`,
                height: `${Math.max(6, (settings.height >= settings.width ? 1 : settings.height / settings.width) * 16)}px`,
              }}
            />
          </span>
          <p className="truncate text-right font-[family-name:var(--font-mono)] text-[11px] tabular-nums text-muted">
            {sizeSummary(settings.width, settings.height)}
          </p>
        </div>
      </Section>
      <div className="px-3 pb-4">
        <Button
          variant={gachaMode ? "default" : "outline"}
          className="w-full"
          onClick={() => setGachaMode(!gachaMode)}
        >
          <Dices className="size-4" />
          {"\u62bd\u5361\u6a21\u5f0f"}{gachaMode
            ? preferences.gachaAutoGenerate
              ? "：自动继续"
              : "：仅随机换词"
            : ""}
        </Button>
        {gachaMode && <p className="mt-2 text-xs text-muted">{[preferences.gachaRandomScene && "随机场景", preferences.gachaRandomArtist && "随机画师串"].filter(Boolean).join(" + ") || "保持当前提示词"} · 首张需手动点击生成</p>}
        <AutomaticGenerationStatus />
      </div>
    </>
  );
}
