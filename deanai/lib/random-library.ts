"use client";

export type RandomScope = "all" | "custom";
export type RandomWeighting = "uniform" | "rating" | "usage" | "rating_usage" | "custom";
export type RandomDirectoryPreset = { id: string; name: string; categories: string[] };
export type RandomKindPreferences = {
  scope: RandomScope;
  categories: string[];
  presetId: string;
  weighting: RandomWeighting;
  minRating: number;
  maxRating: number;
  includeUnrated: boolean;
  ratingWeight: number;
  usageWeight: number;
};
export type RandomLibraryPreferences = {
  artist: RandomKindPreferences;
  prompt: RandomKindPreferences;
  presets: Record<"artist" | "prompt", RandomDirectoryPreset[]>;
  avoidRecent: number;
};
export type RandomLibraryEntry = {
  id: number;
  kind: "artist" | "prompt";
  title: string;
  content: string;
  negative_prompt: string;
};

const KEY = "dean-nai-random-library-v1";
const RECENT_KEY = "dean-nai-random-recent-v1";

export const DEFAULT_RANDOM_LIBRARY_PREFERENCES: RandomLibraryPreferences = {
  artist: { scope: "all", categories: [], presetId: "", weighting: "rating_usage", minRating: 0, maxRating: 5, includeUnrated: true, ratingWeight: 1, usageWeight: 1 },
  prompt: { scope: "all", categories: [], presetId: "", weighting: "usage", minRating: 0, maxRating: 5, includeUnrated: true, ratingWeight: 0, usageWeight: 1 },
  presets: { artist: [], prompt: [] },
  avoidRecent: 5,
};

function normalizeKind(value: Partial<RandomKindPreferences> | undefined, fallback: RandomKindPreferences): RandomKindPreferences {
  const scopes = new Set<RandomScope>(["all", "custom"]);
  const weights = new Set<RandomWeighting>(["uniform", "rating", "usage", "rating_usage", "custom"]);
  const minRating = Math.min(5, Math.max(0, Math.round((Number(value?.minRating) || 0) * 2) / 2));
  const requestedMax = Number(value?.maxRating);
  const maxRating = Math.max(minRating || 0.5, Math.min(5, Math.round((Number.isFinite(requestedMax) ? requestedMax : fallback.maxRating) * 2) / 2));
  const requestedRatingWeight = Number(value?.ratingWeight);
  const requestedUsageWeight = Number(value?.usageWeight);
  return {
    scope: value?.scope && scopes.has(value.scope) ? value.scope : fallback.scope,
    categories: Array.isArray(value?.categories) ? [...new Set(value.categories.map(String).map((item) => item.trim()).filter(Boolean))] : [],
    presetId: typeof value?.presetId === "string" ? value.presetId : "",
    weighting: value?.weighting && weights.has(value.weighting) ? value.weighting : fallback.weighting,
    minRating,
    maxRating,
    includeUnrated: value?.includeUnrated !== false,
    ratingWeight: Math.min(10, Math.max(0, Number.isFinite(requestedRatingWeight) ? requestedRatingWeight : fallback.ratingWeight)),
    usageWeight: Math.min(10, Math.max(0, Number.isFinite(requestedUsageWeight) ? requestedUsageWeight : fallback.usageWeight)),
  };
}


function normalizePresets(value: unknown): RandomDirectoryPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Partial<RandomDirectoryPreset>;
    const id = String(raw.id || "").trim();
    const name = String(raw.name || "").trim();
    if (!id || !name || seen.has(id)) return [];
    seen.add(id);
    const categories = Array.isArray(raw.categories)
      ? [...new Set(raw.categories.map(String).map((category) => category.trim()).filter(Boolean))]
      : [];
    return [{ id, name, categories }];
  });
}

export function loadRandomLibraryPreferences(): RandomLibraryPreferences {
  if (typeof localStorage === "undefined") return DEFAULT_RANDOM_LIBRARY_PREFERENCES;
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "null") as Partial<RandomLibraryPreferences> | null;
    return {
      artist: normalizeKind(value?.artist, DEFAULT_RANDOM_LIBRARY_PREFERENCES.artist),
      prompt: normalizeKind(value?.prompt, DEFAULT_RANDOM_LIBRARY_PREFERENCES.prompt),
      presets: { artist: normalizePresets(value?.presets?.artist), prompt: normalizePresets(value?.presets?.prompt) },
      avoidRecent: Math.min(100, Math.max(0, Number(value?.avoidRecent ?? DEFAULT_RANDOM_LIBRARY_PREFERENCES.avoidRecent) || 0)),
    };
  } catch {
    return DEFAULT_RANDOM_LIBRARY_PREFERENCES;
  }
}

export function saveRandomLibraryPreferences(value: RandomLibraryPreferences) {
  const normalized = {
    artist: normalizeKind(value.artist, DEFAULT_RANDOM_LIBRARY_PREFERENCES.artist),
    prompt: normalizeKind(value.prompt, DEFAULT_RANDOM_LIBRARY_PREFERENCES.prompt),
    presets: { artist: normalizePresets(value.presets?.artist), prompt: normalizePresets(value.presets?.prompt) },
    avoidRecent: Math.min(100, Math.max(0, Number(value.avoidRecent) || 0)),
  };
  localStorage.setItem(KEY, JSON.stringify(normalized));
  return normalized;
}

function recentIds(kind: "artist" | "prompt", limit: number): number[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RECENT_KEY) || "{}") as Record<string, unknown>;
    const values = Array.isArray(saved[kind]) ? saved[kind] : [];
    return values.map(Number).filter(Number.isInteger).slice(0, limit);
  } catch {
    return [];
  }
}

function remember(kind: "artist" | "prompt", id: number, limit: number) {
  let saved: Record<string, number[]> = {};
  try { saved = JSON.parse(sessionStorage.getItem(RECENT_KEY) || "{}") as Record<string, number[]>; } catch {}
  saved[kind] = [id, ...(saved[kind] || []).filter((value) => value !== id)].slice(0, Math.max(1, limit));
  sessionStorage.setItem(RECENT_KEY, JSON.stringify(saved));
}

export async function drawRandomLibraryEntry(kind: "artist" | "prompt"): Promise<RandomLibraryEntry> {
  const preferences = loadRandomLibraryPreferences();
  const selected = preferences[kind];
  const params = new URLSearchParams({ kind, weighting: selected.weighting });
  if (selected.scope === "custom") {
    if (!selected.categories.length) throw new Error("请先在设置中选择至少一个抽取目录。");
    const effectiveCategories = selected.categories.filter((category) =>
      !selected.categories.some((parent) => parent !== category && category.startsWith(parent + "/")),
    );
    effectiveCategories.forEach((category) => params.append("category_prefix", category));
  }
  if (kind === "artist" && !params.has("unrated_only")) {
    if (!params.has("rating_min") && selected.minRating > 0) params.set("rating_min", String(selected.minRating * 2));
    if (!params.has("rating_max") && selected.maxRating < 5) params.set("rating_max", String(selected.maxRating * 2));
    if (selected.includeUnrated) params.set("include_unrated", "1");
  }
  if (selected.weighting === "custom") {
    params.set("rating_weight", String(selected.ratingWeight));
    params.set("usage_weight", String(selected.usageWeight));
  }
  const recent = recentIds(kind, preferences.avoidRecent);
  if (recent.length) params.set("exclude_ids", recent.join(","));
  const response = await fetch("/api/entries/random?" + params.toString(), { cache: "no-store", signal: AbortSignal.timeout(15000) });
  const payload = await response.json() as RandomLibraryEntry & { error?: string };
  if (!response.ok) throw new Error(payload.error || "HTTP " + response.status);
  remember(kind, payload.id, preferences.avoidRecent);
  void fetch("/api/library/entries/" + payload.id + "/use", { method: "POST", keepalive: true }).catch(() => undefined);
  return payload;
}
