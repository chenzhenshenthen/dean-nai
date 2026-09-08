export type ExternalSource = {
  id: string; provider: string; parent_id: string | null; is_collection: boolean;
  title: string; author: string; version: string; source_url: string; nsfw: boolean;
  entry_count: number; image_count: number; cached_count: number; status: string;
  last_sync_at: string | null; error: string;
};

export type ExternalSourceConfig = {
  id: string; title: string; catalog_url: string; source_url: string; author: string;
  description: string; format: "auto" | "json" | "jsonl" | "csv"; entries_path: string;
  asset_base_url: string; encoding: string; field_map: Record<string, string | string[]>;
  nsfw: boolean; max_bytes: number;
};

export type ExternalImage = {
  image_index: number; thumbnail_url: string; thumb_path: string;
  width: number | null; height: number | null; cached_bytes: number;
};

export type ExternalCharacterPrompt = {
  label: string; prompt: string; negative_prompt: string;
};

export type ExternalEntry = {
  source_id: string; external_id: string; source_title: string; source_url: string; title: string;
  prompt: string; negative_prompt: string; category: string; source_note: string;
  character_prompts: ExternalCharacterPrompt[];
  metadata: Record<string, unknown>; favorite: boolean; pinned: boolean;
  personal_note: string; saved_entry_id: number | null; images: ExternalImage[];
};

export function externalCharacterPrompts(entry: Pick<ExternalEntry, "character_prompts" | "metadata">) {
  const direct = Array.isArray(entry.character_prompts) ? entry.character_prompts : [];
  if (direct.length) return direct.filter((item) => item?.prompt?.trim());
  const raw = entry.metadata?.characterPrompts ?? entry.metadata?.character_prompts ?? entry.metadata?.characters;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value, index) => {
    if (typeof value === "string") {
      return value.trim() ? [{ label: "char" + (index + 1), prompt: value.trim(), negative_prompt: "" }] : [];
    }
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const prompt = String(item.prompt ?? item.tags ?? item.text ?? "").trim();
    return prompt ? [{
      label: String(item.label ?? item.name ?? item.title ?? ("char" + (index + 1))),
      prompt,
      negative_prompt: String(item.negative_prompt ?? item.negative ?? item.uc ?? "").trim(),
    }] : [];
  });
}

export function externalFullPrompt(entry: Pick<ExternalEntry, "prompt" | "character_prompts" | "metadata">) {
  return [entry.prompt.trim(), ...externalCharacterPrompts(entry).map((item) => item.prompt.trim())]
    .filter(Boolean)
    .join("\n");
}
export type ExternalJob = {
  id: string; status: "queued" | "running" | "complete" | "failed" | "cancelled";
  phase: string; current: number; total: number; message?: string; error?: string;
};

const IS_STATIC_PWA = process.env.NEXT_PUBLIC_STATIC_PWA === "1";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function loadExternalSources(signal?: AbortSignal) {
  if (IS_STATIC_PWA) {
    const { loadMobileExternalSources } = await import("@/lib/db/mobile-external-library");
    return { sources: await loadMobileExternalSources() as ExternalSource[] };
  }
  return json<{ sources: ExternalSource[] }>("/api/external-libraries/sources", { signal });
}

export async function createCustomExternalSource(payload: {
  title: string; catalog_url: string; source_url?: string; author?: string;
  format?: string; entries_path?: string; asset_base_url?: string;
  field_map?: Record<string, string | string[]>; terms_confirmed: true;
}) {
  return json<ExternalSourceConfig>("/api/external-libraries/custom-sources", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
}

export async function deleteCustomExternalSource(sourceId: string) {
  const response = await fetch("/api/external-libraries/custom-sources/" + encodeURIComponent(sourceId), { method: "DELETE" });
  if (!response.ok) throw new Error((await response.text()) || ("HTTP " + response.status));
}

export async function loadExternalEntries(params: {
  source?: string; search?: string; category?: string; favorites?: boolean;
  pinned?: boolean; page?: number; pageSize?: number; signal?: AbortSignal;
}) {
  if (IS_STATIC_PWA) {
    const { queryMobileExternalLibrary } = await import("@/lib/db/mobile-external-library");
    return await queryMobileExternalLibrary(params) as { entries: ExternalEntry[]; total: number; page: number; page_size: number };
  }
  const query = new URLSearchParams({
    source: params.source || "all", search: params.search || "", category: params.category || "",
    favorites: params.favorites ? "1" : "0", pinned: params.pinned ? "1" : "0",
    page: String(params.page || 1), page_size: String(params.pageSize || 60),
  });
  return json<{ entries: ExternalEntry[]; total: number; page: number; page_size: number }>(
    `/api/external-libraries/entries?${query}`, { signal: params.signal },
  );
}

export async function loadExternalCategories(source: string, signal?: AbortSignal) {
  if (IS_STATIC_PWA) {
    const { getMobileExternalCategories } = await import("@/lib/db/mobile-external-library");
    return { categories: await getMobileExternalCategories(source) };
  }
  return json<{ categories: Array<{ category: string; count: number; parts?: string[] }> }>(
    `/api/external-libraries/categories?source=${encodeURIComponent(source)}`, { signal },
  );
}

export async function startExternalSync(sourceId: string, cacheImages = true) {
  return json<{ job_id: string }>("/api/external-libraries/sync", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_id: sourceId, cache_images: cacheImages }),
  });
}

export async function startExternalCache(sourceId = "all") {
  return json<{ job_id: string }>("/api/external-libraries/cache", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_id: sourceId }),
  });
}

export async function loadExternalJob(jobId: string) {
  return json<ExternalJob>(`/api/external-libraries/jobs/${jobId}`);
}

export async function cancelExternalJob(jobId: string) {
  return json<{ cancelled: boolean }>(`/api/external-libraries/jobs/${jobId}/cancel`, { method: "POST" });
}

function entryUrl(entry: Pick<ExternalEntry, "source_id" | "external_id">, action: string) {
  return `/api/external-libraries/entries/${encodeURIComponent(entry.source_id)}/${encodeURIComponent(entry.external_id)}/${action}`;
}

export async function updateExternalUserData(entry: ExternalEntry, patch: {
  favorite?: boolean; pinned?: boolean; personal_note?: string;
}) {
  if (IS_STATIC_PWA) {
    const { updateMobileExternalUserData } = await import("@/lib/db/mobile-external-library");
    return updateMobileExternalUserData(entry.source_id, entry.external_id, patch);
  }
  return json<{ favorite: boolean; pinned: boolean; personal_note: string }>(entryUrl(entry, "user-data"), {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  });
}

export async function saveExternalToLocal(entry: ExternalEntry) {
  return json<{ entry_id: number }>(entryUrl(entry, "save-local"), { method: "POST" });
}
