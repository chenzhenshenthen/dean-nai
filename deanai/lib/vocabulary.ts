export type VocabularyTag = {
  name: string;
  translation: string;
  hot: number;
  category: string;
  source_file: string;
  pinned: number;
};

export type VocabularyStatus = {
  available: boolean;
  ready: boolean;
  source_count: number;
  indexed_sources: number;
  tag_count: number;
  tag_dir: string;
  imported_at: string | null;
};

export type VocabularySyncStatus = {
  enabled: boolean;
  interval_hours: number;
  last_sync_at: string | null;
  next_sync_at: string | null;
  last_tag_id: number;
  last_error: string | null;
  due: boolean;
  running: boolean;
  remote_tag_count: number;
  translation_count: number;
};

export type VocabularySyncResult = {
  mode: "global" | "scope";
  received: number;
  inserted: number;
  updated: number;
  removed: number;
  skipped: number;
  pages: number;
  scope?: string;
};
export type VocabularyCategory = { category: string; count: number };

const searchCache = new Map<string, VocabularyTag[]>();

export async function searchLocalVocabulary(query: string, limit = 20, category = "", signal?: AbortSignal) {
  const normalized = query.trim();
  if (!normalized && !category) return [];
  const key = `${normalized.toLocaleLowerCase()}|${limit}|${category}`;
  const cached = searchCache.get(key);
  if (cached) return cached;
  const { items } = await browseLocalVocabulary({
    query: normalized,
    limit,
    category,
    signal,
  });
  searchCache.set(key, items);
  return items;
}

export async function browseLocalVocabulary({
  query,
  limit = 60,
  offset = 0,
  category = "",
  pinnedOnly = false,
  signal,
}: {
  query: string;
  limit?: number;
  offset?: number;
  category?: string;
  pinnedOnly?: boolean;
  signal?: AbortSignal;
}) {
  const params = new URLSearchParams({
    q: query.trim(),
    limit: String(limit),
    offset: String(offset),
  });
  if (category) params.set("category", category);
  if (pinnedOnly) params.set("pinned", "1");
  const response = await fetch(`/api/vocabulary/search?${params}`, { signal });
  if (!response.ok) throw new Error(`\u641c\u7d22\u8bcd\u5e93\u5931\u8d25 (${response.status})`);
  const data = await response.json() as { items?: VocabularyTag[]; total?: number };
  return {
    items: Array.isArray(data.items) ? data.items : [],
    total: Number(data.total || 0),
  };
}

export async function setLocalVocabularyPin(name: string, pinned: boolean) {
  const response = await fetch("/api/vocabulary/pin", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, pinned }),
  });
  if (!response.ok) throw new Error((await response.text()) || "\u66f4\u65b0\u7f6e\u9876\u72b6\u6001\u5931\u8d25");
  searchCache.clear();
}

export async function loadVocabularyOverview(signal?: AbortSignal) {
  const [statusResponse, categoryResponse, syncResponse] = await Promise.all([
    fetch("/api/vocabulary/status", { signal }),
    fetch("/api/vocabulary/categories", { signal }),
    fetch("/api/vocabulary/sync/status", { signal }),
  ]);
  if (!statusResponse.ok || !categoryResponse.ok || !syncResponse.ok) throw new Error("\u8bfb\u53d6\u8bcd\u5e93\u72b6\u6001\u5931\u8d25");
  const status = await statusResponse.json() as VocabularyStatus;
  const categoryData = await categoryResponse.json() as { items?: VocabularyCategory[]; status?: VocabularyStatus };
  const sync = await syncResponse.json() as VocabularySyncStatus;
  return { status: categoryData.status || status, categories: categoryData.items || [], sync };
}

async function parseSyncResponse(response: Response) {
  if (!response.ok) throw new Error((await response.text()) || "\u540c\u6b65 Danbooru \u8bcd\u5e93\u5931\u8d25");
  searchCache.clear();
  return response.json() as Promise<{ result: VocabularySyncResult; status: VocabularySyncStatus; vocabulary: VocabularyStatus }>;
}

export async function syncGlobalVocabulary() {
  return parseSyncResponse(await fetch("/api/vocabulary/sync/global", { method: "POST" }));
}

export async function syncVocabularyScope(scope: string, minPosts = 1, category: number | null = 4) {
  return parseSyncResponse(await fetch("/api/vocabulary/sync/scope", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, min_posts: minPosts, category }),
  }));
}

export async function updateVocabularySyncSettings(enabled: boolean, intervalHours: number) {
  const response = await fetch("/api/vocabulary/sync/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, interval_hours: intervalHours }),
  });
  if (!response.ok) throw new Error((await response.text()) || "\u4fdd\u5b58\u8bcd\u5e93\u540c\u6b65\u8bbe\u7f6e\u5931\u8d25");
  return response.json() as Promise<VocabularySyncStatus>;
}

export async function setLocalVocabularyTranslation(name: string, translation: string) {
  const response = await fetch("/api/vocabulary/translation", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, translation }),
  });
  if (!response.ok) throw new Error((await response.text()) || "\u4fdd\u5b58\u4e2d\u6587\u7ffb\u8bd1\u5931\u8d25");
  searchCache.clear();
  return response.json() as Promise<{ name: string; translation: string; updated: boolean }>;
}

export async function rebuildLocalVocabulary() {
  const response = await fetch("/api/vocabulary/reindex", { method: "POST" });
  if (!response.ok) throw new Error((await response.text()) || "\u66f4\u65b0\u8bcd\u5e93\u5931\u8d25");
  searchCache.clear();
  return response.json() as Promise<VocabularyStatus>;
}
