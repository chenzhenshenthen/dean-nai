// UI option lists for the generation form. Values come straight from nekoai-js enums
// (so they stay in sync with the SDK); labels mirror the wording of NovelAI's own UI.
import { Model, Sampler, Noise, Resolution, EmotionOptions, RESOLUTION_DIMENSIONS } from "nekoai-js";
import { calculateCost } from "nekoai-js";
import type { GenerationSettings } from "@/lib/nai/types";
import { toMetadata } from "@/lib/nai/types";

type Option<T extends string> = { value: T; label: string };

// nekoai-js 1.3 predates NovelAI Diffusion V5. Keep the compatibility ids here instead of
// patching node_modules so a clean npm install remains reproducible.
export const V5_FULL = "nai-diffusion-5-full" as Model;
export const V5_CURATED = "nai-diffusion-5-curated" as Model;
export const isV5Model = (model: Model | string) => model === V5_FULL || model === V5_CURATED;

export const V5_DEFAULT_STEPS = 28;
export const V5_DEFAULT_SCALE = 4;
export const V5_MAX_CHARACTERS = 22;
export const V5_TOKEN_LIMITS = {
  [V5_FULL]: 1471,
  [V5_CURATED]: 703,
};

type ModelTuning = Pick<GenerationSettings,
  | "steps"
  | "sampler"
  | "scale"
  | "cfgRescale"
  | "noiseSchedule"
  | "ucPreset"
  | "qualityToggle"
  | "qualityTier"
  | "dynamicThresholding"
  | "autoSmea"
  | "transparentBackground"
  | "straightAlpha"
>;

const MODEL_TUNING_KEY = "deanai-model-tuning-v1";

function tuningFromSettings(settings: GenerationSettings): ModelTuning {
  return {
    steps: settings.steps,
    sampler: settings.sampler,
    scale: settings.scale,
    cfgRescale: settings.cfgRescale,
    noiseSchedule: settings.noiseSchedule,
    ucPreset: settings.ucPreset,
    qualityToggle: settings.qualityToggle,
    qualityTier: settings.qualityTier,
    dynamicThresholding: settings.dynamicThresholding,
    autoSmea: settings.autoSmea,
    transparentBackground: settings.transparentBackground,
    straightAlpha: settings.straightAlpha,
  };
}

export function saveModelTuning(settings: GenerationSettings) {
  if (typeof localStorage === "undefined") return;
  try {
    const profiles = JSON.parse(localStorage.getItem(MODEL_TUNING_KEY) || "{}") as Record<string, ModelTuning>;
    profiles[String(settings.model)] = tuningFromSettings(settings);
    localStorage.setItem(MODEL_TUNING_KEY, JSON.stringify(profiles));
  } catch {
    // Model switching must still work when storage is unavailable or corrupted.
  }
}

export function loadModelTuning(model: Model): Partial<ModelTuning> | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const profiles = JSON.parse(localStorage.getItem(MODEL_TUNING_KEY) || "{}") as Record<string, Partial<ModelTuning>>;
    return profiles[String(model)] ?? null;
  } catch {
    return null;
  }
}

export function defaultModelTuning(model: Model): Pick<ModelTuning, "steps" | "scale"> {
  return isV5Model(model)
    ? { steps: V5_DEFAULT_STEPS, scale: V5_DEFAULT_SCALE }
    : { steps: 28, scale: 5.5 };
}

export const MODEL_OPTIONS: Option<Model>[] = [
  { value: V5_FULL, label: "NAI Diffusion V5 Full" },
  { value: V5_CURATED, label: "NAI Diffusion V5 Curated" },
  { value: Model.V4_5, label: "NAI Diffusion V4.5 Full" },
  { value: Model.V4_5_CUR, label: "NAI Diffusion V4.5 Curated" },
  { value: Model.V4, label: "NAI Diffusion V4 Full" },
  { value: Model.V4_CUR, label: "NAI Diffusion V4 Curated" },
  { value: Model.V3, label: "NAI Diffusion Anime V3" },
  { value: Model.FURRY, label: "NAI Diffusion Furry V3" },
];

export function modelLabel(value: string, compact = false): string {
  const label = MODEL_OPTIONS.find((option) => option.value === value)?.label ?? value;
  return compact ? label.replace(/^NAI Diffusion /, "").replace(/ Full$/, "") : label;
}

/** V4/V4.5 models support multi-character prompts + positional coords. */
export const V4_MODELS = new Set<Model>([
  V5_FULL,
  V5_CURATED,
  Model.V4_5,
  Model.V4_5_CUR,
  Model.V4,
  Model.V4_CUR,
]);

export const isV4Model = (m: Model) => V4_MODELS.has(m);

export function modelFromSource(source: string): Model | null {
  const normalized = source.toLowerCase();
  if (normalized.includes("naiv5") || normalized.includes("diffusion v5") || normalized.includes("diffusion-5")) {
    return normalized.includes("657484a5") || normalized.includes("0adf9ab7") || normalized.includes("full") ? V5_FULL : V5_CURATED;
  }
  if (normalized.includes("v4.5") || normalized.includes("diffusion-4-5")) {
    if (normalized.includes("curated")) return Model.V4_5_CUR;
    if (normalized.includes("4bde2a90") || normalized.includes("full") || normalized.includes("diffusion-4-5-full")) return Model.V4_5;
  }
  if (normalized.includes("furry")) return Model.FURRY;
  if (normalized.includes("v4") || normalized.includes("diffusion-4")) return normalized.includes("curated") ? Model.V4_CUR : Model.V4;
  if (normalized.includes("v3") || normalized.includes("diffusion-3")) return Model.V3;
  return null;
}

export function estimateGenerationCost(settings: GenerationSettings, isOpus: boolean, opusQuotaExhausted = false) {
  const meta = toMetadata(settings, settings.seed < 0 ? 0 : settings.seed);
  const opusApplies = isOpus && !(isV5Model(settings.model) && opusQuotaExhausted);
  const base = calculateCost(meta, opusApplies);
  return isV5Model(settings.model) ? Math.ceil(base * 1.5) : base;
}

export const SAMPLER_OPTIONS: Option<Sampler>[] = [
  { value: Sampler.EULER, label: "Euler" },
  { value: Sampler.EULER_ANC, label: "Euler Ancestral" },
  { value: Sampler.DPM2S_ANC, label: "DPM++ 2S Ancestral" },
  { value: Sampler.DPM2M, label: "DPM++ 2M" },
  { value: Sampler.DPMSDE, label: "DPM++ SDE" },
  { value: Sampler.DPM2MSDE, label: "DPM++ 2M SDE" },
  { value: Sampler.DDIM, label: "DDIM" },
];

export const NOISE_OPTIONS: Option<Noise>[] = [
  { value: Noise.KARRAS, label: "Karras" },
  { value: Noise.NATIVE, label: "Native" },
  { value: Noise.EXPONENTIAL, label: "Exponential" },
  { value: Noise.POLYEXPONENTIAL, label: "Polyexponential" },
];

export const UC_PRESET_OPTIONS: Option<string>[] = [
  { value: "0", label: "Heavy" },
  { value: "1", label: "Light" },
  { value: "2", label: "Human Focus" },
  { value: "3", label: "None" },
];

export const SIZE_TIERS = ["small", "normal", "large", "wallpaper"] as const;
const ASPECTS = ["portrait", "landscape", "square"] as const;
export type SizeTier = (typeof SIZE_TIERS)[number];
export type Aspect = (typeof ASPECTS)[number];

type ResolutionPreset = { value: Resolution; label: string; w: number; h: number };

// Derive the preset table from the SDK rather than duplicating every enum and dimension. The SDK
// intentionally has no wallpaper-square entry, so that combination is filtered out.
const ALL_PRESETS: ResolutionPreset[] = SIZE_TIERS.flatMap((tier) =>
  ASPECTS.flatMap((aspect) => {
    const value = `${tier}_${aspect}` as Resolution;
    const dimensions = RESOLUTION_DIMENSIONS[value];
    return dimensions
      ? [{ value, label: aspect.charAt(0).toUpperCase() + aspect.slice(1), w: dimensions[0], h: dimensions[1] }]
      : [];
  }),
);

const PRESET_BY_KEY: Record<string, ResolutionPreset> = Object.fromEntries(
  ALL_PRESETS.map((preset) => [preset.value as string, preset]),
);

/** Preset dimensions for a tier + aspect (Resolution values are `${tier}_${aspect}`). */
export function presetDims(tier: string, aspect: string): ResolutionPreset | undefined {
  return PRESET_BY_KEY[`${tier}_${aspect}`];
}

/** Find the preset whose dimensions match the given size, if any (else "custom"). */
function presetForSize(w: number, h: number): Resolution | null {
  return ALL_PRESETS.find((p) => p.w === w && p.h === h)?.value ?? null;
}

/** Split a size into [tier, aspect] if it matches a preset, else [null, null]. */
export function tierAspectForSize(w: number, h: number): [SizeTier | null, Aspect | null] {
  const preset = presetForSize(w, h);
  if (!preset) return [null, null];
  const [tier, aspect] = (preset as string).split("_");
  return [tier as SizeTier, aspect as Aspect];
}

/** Aspects that actually exist for a tier — Wallpaper has no Square, so offering it would force a
 *  silent fallback that changes the user's aspect behind their back. */
export function aspectsForTier(tier: string): Aspect[] {
  return ASPECTS.filter((a) => presetDims(tier, a) !== undefined);
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** "1.01 MP · 1:1.46" — the cost and shape of the current size, for the custom W/H row. */
export function sizeSummary(w: number, h: number): string {
  if (!w || !h) return "—";
  const mp = (w * h) / 1_000_000;
  const g = gcd(w, h) || 1;
  const [rw, rh] = [w / g, h / g];
  // Only show an integer ratio when it's one a human recognises. 832x1216 reduces to 13:19, which
  // is exact and completely unreadable — normalise those to 1:n instead.
  const ratio =
    rw <= 16 && rh <= 16
      ? `${rw}:${rh}`
      : w >= h
        ? `${(w / h).toFixed(2)}:1`
        : `1:${(h / w).toFixed(2)}`;
  return `${mp.toFixed(2)} MP · ${ratio}`;
}

export const EMOTION_OPTIONS: Option<EmotionOptions>[] = Object.values(EmotionOptions).map((e) => ({
  value: e,
  label: e.charAt(0).toUpperCase() + e.slice(1),
}));
