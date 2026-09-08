export type MobileExternalSource = {
  id: string; provider: string; parent_id: string | null; is_collection: boolean;
  title: string; author: string; version: string; source_url: string; nsfw: boolean;
  entry_count: number; image_count: number; cached_count: number; status: string;
  last_sync_at: string | null; error: string;
};

export type MobileExternalImage = {
  image_index: number; thumbnail_url: string; thumb_path: string; thumbnail_data_url?: string;
  width: number | null; height: number | null; cached_bytes: number;
};

export type MobileExternalEntry = {
  key: string; source_id: string; external_id: string; source_title: string; source_url: string;
  title: string; prompt: string; negative_prompt: string; category: string; source_note: string;
  character_prompts: Array<{ label: string; prompt: string; negative_prompt: string }>;
  metadata: Record<string, unknown>; favorite: boolean; pinned: boolean; personal_note: string;
  saved_entry_id: number | null; images: MobileExternalImage[];
};

type PortablePayload = { external_sources?: unknown[]; external_entries?: unknown[] };
const DB_NAME = "deanai-mobile-external-library";
const DB_VERSION = 1;
const SOURCES = "sources";
const ENTRIES = "entries";
const THUMBNAILS = "thumbnails";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SOURCES)) db.createObjectStore(SOURCES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: "key" });
      if (!db.objectStoreNames.contains(THUMBNAILS)) db.createObjectStore(THUMBNAILS, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("外置资料写入已中止"));
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function sourceFrom(value: unknown): MobileExternalSource | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  return {
    id, provider: String(raw.provider || "portable"), parent_id: raw.parent_id ? String(raw.parent_id) : null,
    is_collection: Boolean(raw.is_collection), title: String(raw.title || id), author: String(raw.author || ""),
    version: String(raw.version || ""), source_url: String(raw.source_url || ""), nsfw: Boolean(raw.nsfw),
    entry_count: Number(raw.entry_count) || 0, image_count: Number(raw.image_count) || 0,
    cached_count: Number(raw.cached_count) || 0, status: String(raw.status || "portable"),
    last_sync_at: typeof raw.last_sync_at === "string" ? raw.last_sync_at : null, error: String(raw.error || ""),
  };
}

function entryFrom(value: unknown): MobileExternalEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const sourceId = String(raw.source_id || "").trim();
  const externalId = String(raw.external_id || "").trim();
  if (!sourceId || !externalId) return null;
  const metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata as Record<string, unknown> : {};
  const characterSource = Array.isArray(raw.character_prompts) ? raw.character_prompts
    : Array.isArray(metadata.characterPrompts) ? metadata.characterPrompts
    : Array.isArray(metadata.character_prompts) ? metadata.character_prompts : [];
  const characterPrompts = characterSource.flatMap((value, index) => {
    if (typeof value === "string") {
      return value.trim() ? [{ label: "char" + (index + 1), prompt: value.trim(), negative_prompt: "" }] : [];
    }
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const prompt = String(item.prompt ?? item.tags ?? item.text ?? "").trim();
    return prompt ? [{
      label: String(item.label ?? item.name ?? ("char" + (index + 1))),
      prompt,
      negative_prompt: String(item.negative_prompt ?? item.negative ?? item.uc ?? "").trim(),
    }] : [];
  });
  const images = Array.isArray(raw.images) ? raw.images.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const image = value as Record<string, unknown>;
    const imageIndex = Number(image.image_index);
    if (!Number.isInteger(imageIndex) || imageIndex < 0) return [];
    return [{
      image_index: imageIndex, thumbnail_url: "", thumb_path: "",
      thumbnail_data_url: typeof image.thumbnail_data_url === "string" ? image.thumbnail_data_url : undefined,
      width: Number(image.width) || null, height: Number(image.height) || null,
      cached_bytes: Number(image.cached_bytes) || 0,
    }];
  }) : [];
  return {
    key: `${sourceId}\u0000${externalId}`, source_id: sourceId, external_id: externalId,
    source_title: String(raw.source_title || sourceId), source_url: String(raw.source_url || ""),
    title: String(raw.title || "未命名"), prompt: String(raw.prompt || ""),
    negative_prompt: String(raw.negative_prompt || ""), category: String(raw.category || ""),
    source_note: String(raw.source_note || ""), character_prompts: characterPrompts,
    metadata,
    favorite: Boolean(raw.favorite), pinned: Boolean(raw.pinned), personal_note: String(raw.personal_note || ""),
    saved_entry_id: Number.isInteger(Number(raw.saved_entry_id)) ? Number(raw.saved_entry_id) : null, images,
  };
}

export async function importMobileExternalLibrary(payload: PortablePayload) {
  const sources = (payload.external_sources || []).map(sourceFrom).filter((x): x is MobileExternalSource => Boolean(x));
  const entries = (payload.external_entries || []).map(entryFrom).filter((x): x is MobileExternalEntry => Boolean(x));
  if (!sources.length && !entries.length) return 0;
  const db = await openDB();
  const transaction = db.transaction([SOURCES, ENTRIES, THUMBNAILS], "readwrite");
  const sourceStore = transaction.objectStore(SOURCES);
  const entryStore = transaction.objectStore(ENTRIES);
  const thumbnailStore = transaction.objectStore(THUMBNAILS);
  sources.forEach((source) => sourceStore.put(source));
  entries.forEach((entry) => {
    entry.images.forEach((image) => {
      if (image.thumbnail_data_url) thumbnailStore.put({ key: `${entry.key}\u0000${image.image_index}`, data_url: image.thumbnail_data_url });
    });
    entryStore.put({ ...entry, images: entry.images.map(({ thumbnail_data_url: _data, ...image }) => image) });
  });
  await done(transaction);
  db.close();
  return entries.length;
}

export async function loadMobileExternalSources(): Promise<MobileExternalSource[]> {
  const db = await openDB();
  const sources = await result(db.transaction(SOURCES, "readonly").objectStore(SOURCES).getAll() as IDBRequest<MobileExternalSource[]>);
  db.close();
  return sources.sort((a, b) => a.parent_id === b.parent_id
    ? a.title.localeCompare(b.title, "zh-CN", { numeric: true }) : a.parent_id ? 1 : -1);
}

async function allEntries(): Promise<MobileExternalEntry[]> {
  const db = await openDB();
  const entries = await result(db.transaction(ENTRIES, "readonly").objectStore(ENTRIES).getAll() as IDBRequest<MobileExternalEntry[]>);
  db.close();
  return entries;
}

function allowedSources(source: string, sources: MobileExternalSource[]) {
  if (!source || source === "all") return null;
  return new Set([source, ...sources.filter((item) => item.parent_id === source).map((item) => item.id)]);
}

async function hydrate(entry: MobileExternalEntry) {
  if (!entry.images.length) return entry;
  const db = await openDB();
  const store = db.transaction(THUMBNAILS, "readonly").objectStore(THUMBNAILS);
  const images = await Promise.all(entry.images.map(async (image) => {
    const thumbnail = await result(store.get(`${entry.key}\u0000${image.image_index}`) as IDBRequest<{ data_url: string } | undefined>);
    return { ...image, thumbnail_url: thumbnail?.data_url || "" };
  }));
  db.close();
  return { ...entry, images };
}

export async function queryMobileExternalLibrary(params: {
  source?: string; search?: string; category?: string; favorites?: boolean;
  pinned?: boolean; page?: number; pageSize?: number;
}) {
  const sources = await loadMobileExternalSources();
  const allowed = allowedSources(params.source || "all", sources);
  const search = (params.search || "").trim().toLocaleLowerCase();
  const category = (params.category || "").trim();
  const entries = (await allEntries()).filter((entry) => {
    if (allowed && !allowed.has(entry.source_id)) return false;
    if (params.favorites && !entry.favorite) return false;
    if (params.pinned && !entry.pinned) return false;
    if (category && entry.category !== category && !entry.category.startsWith(`${category}/`)) return false;
    return !search || [entry.title, entry.prompt, ...entry.character_prompts.map((item) => item.prompt), entry.negative_prompt, entry.category, entry.source_note]
      .join("\n").toLocaleLowerCase().includes(search);
  });
  entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title, "zh-CN", { numeric: true }));
  const page = Math.max(1, params.page || 1);
  const pageSize = Math.max(1, Math.min(120, params.pageSize || 60));
  const visible = await Promise.all(entries.slice((page - 1) * pageSize, page * pageSize).map(hydrate));
  return { entries: visible, total: entries.length, page, page_size: pageSize };
}

export async function getMobileExternalCategories(source = "all") {
  const sources = await loadMobileExternalSources();
  const allowed = allowedSources(source, sources);
  const counts = new Map<string, number>();
  (await allEntries()).forEach((entry) => {
    if ((!allowed || allowed.has(entry.source_id)) && entry.category) counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
  });
  return [...counts].map(([category, count]) => ({ category, count, parts: category.split("/").filter(Boolean) }))
    .sort((a, b) => a.category.localeCompare(b.category, "zh-CN", { numeric: true }));
}

export async function updateMobileExternalUserData(sourceId: string, externalId: string, patch: {
  favorite?: boolean; pinned?: boolean; personal_note?: string;
}) {
  const key = `${sourceId}\u0000${externalId}`;
  const db = await openDB();
  const entry = await result(db.transaction(ENTRIES, "readonly").objectStore(ENTRIES).get(key) as IDBRequest<MobileExternalEntry | undefined>);
  if (!entry) { db.close(); throw new Error("手机外置资料中找不到该条目"); }
  const next = { ...entry, ...patch };
  const transaction = db.transaction(ENTRIES, "readwrite");
  transaction.objectStore(ENTRIES).put(next);
  await done(transaction);
  db.close();
  return { favorite: next.favorite, pinned: next.pinned, personal_note: next.personal_note };
}
