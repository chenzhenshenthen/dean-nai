"use client";

const ZH = {
  artist: "\u753b\u5e08\u4e32\u540d",
  scene: "\u573a\u666f\u540d",
  timestamp: "\u65f6\u95f4\u6233",
  epoch: "\u6beb\u79d2\u65f6\u95f4\u6233",
  index: "\u5e8f\u53f7",
  unnamedArtist: "\u672a\u547d\u540d\u753b\u5e08\u4e32",
  unnamedScene: "\u672a\u547d\u540d\u573a\u666f",
} as const;

const PREVIOUS_DEFAULT_FILENAME_TEMPLATE = `{{${ZH.artist}}}-{{${ZH.scene}}}-{{${ZH.timestamp}}}-{{${ZH.index}}}`;
export const DEFAULT_FILENAME_TEMPLATE = `deanai_{{${ZH.epoch}}}_{{${ZH.index}}}`;

export type AppPreferences = {
  autoSave: boolean;
  saveDirectory: string;
  filenameTemplate: string;
  warnHighCost: boolean;
  highCostThreshold: number;
  generationIntervalSeconds: number;
  gachaAutoGenerate: boolean;
  gachaAutoGenerateIntervalSeconds: number;
  gachaRandomScene: boolean;
  gachaRandomArtist: boolean;
  gachaMaxIntervalSeconds: number;
  gachaMaxImages: number;
  gachaMaxMinutes: number;
  gachaAnlasBudget: number;
  gachaRestEvery: number;
  gachaRestSeconds: number;
  gachaStopWhenHidden: boolean;
  logRetentionDays: number;
  assumeOpusFreeImages: boolean;
  showExternalLibraryInPicker: boolean;
};

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  autoSave: false,
  saveDirectory: "",
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  warnHighCost: true,
  highCostThreshold: 50,
  generationIntervalSeconds: 0,
  gachaAutoGenerate: false,
  gachaAutoGenerateIntervalSeconds: 30,
  gachaRandomScene: true,
  gachaRandomArtist: false,
  gachaMaxIntervalSeconds: 60,
  gachaMaxImages: 20,
  gachaMaxMinutes: 30,
  gachaAnlasBudget: 0,
  gachaRestEvery: 10,
  gachaRestSeconds: 300,
  gachaStopWhenHidden: true,
  logRetentionDays: 30,
  assumeOpusFreeImages: false,
  showExternalLibraryInPicker: true,
};

const KEY = "dean-nai-app-preferences-v1";
const LEGACY_SETTINGS_KEY = "nya-settings";

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function migrateLegacyTemplate(): string | null {
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_SETTINGS_KEY) || "{}") as { filenameTemplate?: unknown };
    if (typeof legacy.filenameTemplate !== "string" || !legacy.filenameTemplate.trim()) return null;
    return legacy.filenameTemplate
      .replace(/xxx/gi, `{{${ZH.timestamp}}}-{{${ZH.index}}}`)
      .replace(/^nyanovel[-_]?/i, "dean-nai-");
  } catch {
    return null;
  }
}

export function normalizeAppPreferences(value: Partial<AppPreferences> | null | undefined): AppPreferences {
  return {
    autoSave: Boolean(value?.autoSave),
    saveDirectory: typeof value?.saveDirectory === "string" ? value.saveDirectory.trim() : "",
    filenameTemplate: typeof value?.filenameTemplate === "string" && value.filenameTemplate.trim()
      ? (value.filenameTemplate.trim() === PREVIOUS_DEFAULT_FILENAME_TEMPLATE ? DEFAULT_FILENAME_TEMPLATE : value.filenameTemplate.trim())
      : DEFAULT_FILENAME_TEMPLATE,
    warnHighCost: value?.warnHighCost !== false,
    highCostThreshold: clampNumber(value?.highCostThreshold, 50, 1, 100000),
    generationIntervalSeconds: clampNumber(value?.generationIntervalSeconds, 0, 0, 3600),
    gachaAutoGenerate: Boolean(value?.gachaAutoGenerate),
    gachaAutoGenerateIntervalSeconds: clampNumber(value?.gachaAutoGenerateIntervalSeconds, 30, 5, 3600),
    gachaRandomScene: value?.gachaRandomScene !== false,
    gachaRandomArtist: Boolean(value?.gachaRandomArtist),
    gachaMaxIntervalSeconds: Math.max(clampNumber(value?.gachaAutoGenerateIntervalSeconds, 30, 5, 3600), clampNumber(value?.gachaMaxIntervalSeconds, 60, 5, 3600)),
    gachaMaxImages: Math.floor(clampNumber(value?.gachaMaxImages, 20, 1, 1000)),
    gachaMaxMinutes: clampNumber(value?.gachaMaxMinutes, 30, 1, 1440),
    gachaAnlasBudget: clampNumber(value?.gachaAnlasBudget, 0, 0, 100000),
    gachaRestEvery: Math.floor(clampNumber(value?.gachaRestEvery, 10, 0, 1000)),
    gachaRestSeconds: clampNumber(value?.gachaRestSeconds, 300, 0, 3600),
    gachaStopWhenHidden: value?.gachaStopWhenHidden !== false,
    logRetentionDays: clampNumber(value?.logRetentionDays, 30, 1, 3650),
    assumeOpusFreeImages: Boolean(value?.assumeOpusFreeImages),
    showExternalLibraryInPicker: value?.showExternalLibraryInPicker !== false,
  };
}

export function loadAppPreferences(): AppPreferences {
  if (typeof localStorage === "undefined") return DEFAULT_APP_PREFERENCES;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return normalizeAppPreferences(JSON.parse(saved) as Partial<AppPreferences>);
  } catch {
    // Corrupt optional preferences fall back to safe defaults.
  }
  const migrated = normalizeAppPreferences({ ...DEFAULT_APP_PREFERENCES, filenameTemplate: migrateLegacyTemplate() || DEFAULT_FILENAME_TEMPLATE });
  saveAppPreferences(migrated);
  return migrated;
}

export function saveAppPreferences(value: AppPreferences): AppPreferences {
  const normalized = normalizeAppPreferences(value);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent("dean-nai-preferences-changed", { detail: normalized }));
  }
  return normalized;
}

export const FILENAME_PLACEHOLDERS = [ZH.artist, ZH.scene, ZH.timestamp, ZH.epoch, ZH.index, "artist", "scene", "timestamp", "epoch", "index"] as const;
const PLACEHOLDER_SET = new Set<string>(FILENAME_PLACEHOLDERS);

export function unknownFilenamePlaceholders(template: string): string[] {
  const found = [...template.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1].trim());
  return [...new Set(found.filter((key) => !PLACEHOLDER_SET.has(key)))];
}

function readableTimestamp(value: number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const two = (part: number) => String(part).padStart(2, "0");
  return [date.getFullYear(), two(date.getMonth() + 1), two(date.getDate()), "-", two(date.getHours()), two(date.getMinutes()), two(date.getSeconds())].join("");
}

function cleanSegment(value: string, fallback: string) {
  return (value.trim() || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim();
}

export function renderFilename(template: string, values: { artistName?: string; sceneName?: string; timestamp?: number | Date; index?: number }): string {
  const stamp = readableTimestamp(values.timestamp ?? new Date());
  const epoch = String((values.timestamp instanceof Date ? values.timestamp : new Date(values.timestamp ?? Date.now())).getTime());
  const index = String(values.index ?? 1);
  const replacements: Record<string, string> = {
    [ZH.artist]: cleanSegment(values.artistName || "", ""), artist: cleanSegment(values.artistName || "", ""),
    [ZH.scene]: cleanSegment(values.sceneName || "", ""), scene: cleanSegment(values.sceneName || "", ""),
    [ZH.timestamp]: stamp, timestamp: stamp, [ZH.epoch]: epoch, epoch, [ZH.index]: index, index,
  };
  const source = template.trim() || DEFAULT_FILENAME_TEMPLATE;
  const safeTemplate = unknownFilenamePlaceholders(source).length ? DEFAULT_FILENAME_TEMPLATE : source;
  let name = safeTemplate.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => replacements[key.trim()] || "");
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/-{2,}/g, "-").replace(/[_ ]{2,}/g, " ").replace(/^[. _-]+|[. _-]+$/g, "").trim();
  if (name.length > 180) name = name.slice(0, 180).replace(/[. ]+$/g, "");
  return `${name || `deanai_${epoch}_${index}`}.png`;
}
