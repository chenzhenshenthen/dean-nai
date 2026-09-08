import { Model, Noise, Sampler } from "nekoai-js";
import { saveSettings } from "@/lib/nai/client";
import { DEFAULT_SETTINGS, type CharacterSetting, type GenerationSettings } from "@/lib/nai/types";
import { modelFromSource } from "@/lib/nai/models";
import { useStore } from "@/lib/store";
import { navigateDesktopWorkspace } from "@/lib/workspace-navigation";

export type PortableMetadata = {
  positive_prompt?: string;
  negative_prompt?: string;
  characters?: string[];
  negative_characters?: string[];
  parameters?: Record<string, unknown>;
  raw_fields?: Record<string, unknown>;
};

const number = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function detectModel(metadata: PortableMetadata): Model {
  const source = Object.values(metadata.raw_fields || {}).join(" ").toLowerCase();
  return modelFromSource(String(metadata.parameters?.model || source)) || DEFAULT_SETTINGS.model;
}

export function recipeFromMetadata(metadata: PortableMetadata, width = 0, height = 0): GenerationSettings {
  const p = metadata.parameters || {};
  const prompts = Array.isArray(metadata.characters) ? metadata.characters : [];
  const negatives = Array.isArray(metadata.negative_characters) ? metadata.negative_characters : [];
  const characters: CharacterSetting[] = prompts.map((prompt, index) => ({
    prompt: String(prompt || ""), uc: String(negatives[index] || ""),
    center: { x: 0.5, y: 0.5 }, enabled: true,
  }));
  const samplerValues = new Set(Object.values(Sampler));
  const noiseValues = new Set(Object.values(Noise));
  const sampler = String(p.sampler || DEFAULT_SETTINGS.sampler) as Sampler;
  const noise = String(p.noise_schedule || DEFAULT_SETTINGS.noiseSchedule) as Noise;
  return {
    ...DEFAULT_SETTINGS,
    prompt: String(metadata.positive_prompt || ""),
    negativePrompt: String(metadata.negative_prompt || ""),
    model: detectModel(metadata),
    width: number(p.width, width || DEFAULT_SETTINGS.width),
    height: number(p.height, height || DEFAULT_SETTINGS.height),
    steps: number(p.steps, DEFAULT_SETTINGS.steps),
    seed: number(p.seed, DEFAULT_SETTINGS.seed),
    sampler: samplerValues.has(sampler) ? sampler : DEFAULT_SETTINGS.sampler,
    scale: number(p.scale, DEFAULT_SETTINGS.scale),
    cfgRescale: number(p.cfg_rescale, DEFAULT_SETTINGS.cfgRescale),
    noiseSchedule: noiseValues.has(noise) ? noise : DEFAULT_SETTINGS.noiseSchedule,
    nSamples: 1,
    dynamicThresholding: Boolean(p.dynamic_thresholding),
    autoSmea: Boolean(p.sm || p.sm_dyn),
    characters,
  };
}

export function sendRecipeToStudio(recipe: GenerationSettings) {
  const current = useStore.getState().settings;
  const merged = {
    ...recipe,
    artistPrompt: current.artistPrompt,
    artistPromptName: current.artistPromptName,
    scenePrompt: current.scenePrompt,
    scenePromptName: current.scenePromptName,
  };
  saveSettings(merged);
  if (navigateDesktopWorkspace("studio")) {
    useStore.setState({ settings: merged });
    return;
  }
  window.location.href = "/";
}

export function sendPromptToStudio(prompt: string) {
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  const current = useStore.getState().settings;
  const merged = { ...current, prompt: trimmed };
  saveSettings(merged);
  if (navigateDesktopWorkspace("studio")) {
    useStore.setState({ settings: merged });
  } else {
    window.location.href = "/";
  }
  return true;
}
