import { normalizeRatingFilter, ratingMatches } from "@/lib/rating-filter";

export type MobileLibraryKind = "artist" | "prompt";

export type MobileLibraryImage = {
  id: number;
  thumbnail_data_url?: string;
  width?: number | null;
  height?: number | null;
};

export type MobileLibraryEntry = {
  id: number;
  kind: MobileLibraryKind;
  title: string;
  content: string;
  negative_prompt: string;
  category: string;
  style: string;
  rating: number | null;
  rating_value: number | null;
  favorite: number;
  pinned: number;
  manual_order: number;
  usage_count: number;
  last_used_at?: string | null;
  created_at?: string;
  updated_at?: string;
  tags: string[];
  groups: Array<{ id: number; name: string }>;
  images: MobileLibraryImage[];
};

export type MobileLibraryCategory = { name: string; count: number; sort_order: number };
export type MobileLibraryGroup = { id: number; kind: MobileLibraryKind; name: string; count: number };
export type MobileRatingCounts = {
  all_count: number;
  at_least_9: number;
  exactly_8: number;
  between_6_and_7: number;
  at_most_5: number;
  unrated: number;
};
export type MobileStyleCounts = MobileRatingCounts & { name: string };
export type MobileNavigation = {
  categories: Record<MobileLibraryKind, MobileLibraryCategory[]>;
  groups: Record<MobileLibraryKind, MobileLibraryGroup[]>;
  totals: Record<MobileLibraryKind, number>;
  ratings: MobileRatingCounts;
  styles: MobileStyleCounts[];
};

export type MobileLibraryPayload = {
  format?: string;
  entries?: unknown[];
};

const DB_NAME = "nyanovel-mobile-library";
const DB_VERSION = 2;
const STORE = "entries";
const THUMBNAILS_STORE = "thumbnails";
const META_STORE = "meta";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const transaction = request.transaction;
      if (!transaction) return;
      const entries = db.objectStoreNames.contains(STORE)
        ? transaction.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: "id" });
      if (!entries.indexNames.contains("kind")) entries.createIndex("kind", "kind", { unique: false });
      const thumbnails = db.objectStoreNames.contains(THUMBNAILS_STORE)
        ? transaction.objectStore(THUMBNAILS_STORE)
        : db.createObjectStore(THUMBNAILS_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "key" });

      // V1 embedded every Base64 thumbnail inside every card. Move those large strings into a
      // separate store once so ordinary filtering only reads lightweight card metadata.
      if ((event.oldVersion || 0) < 2) {
        const cursorRequest = entries.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const entry = cursor.value as MobileLibraryEntry;
          entry.images.forEach((image) => {
            if (image.thumbnail_data_url) {
              thumbnails.put({ id: image.id, data_url: image.thumbnail_data_url });
            }
          });
          cursor.update(withoutEmbeddedThumbnails(entry));
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("资料库事务已中止"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withoutEmbeddedThumbnails(entry: MobileLibraryEntry): MobileLibraryEntry {
  return {
    ...entry,
    images: entry.images.map(({ thumbnail_data_url: _thumbnail, ...image }) => image),
  };
}

function sanitizeEntry(value: unknown): MobileLibraryEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = Number(raw.id);
  const kind = raw.kind === "prompt" ? "prompt" : raw.kind === "artist" ? "artist" : null;
  if (!Number.isInteger(id) || id < 1 || !kind) return null;
  const rating = raw.rating === null || raw.rating === undefined || raw.rating === "" ? null : Number(raw.rating);
  const groups = Array.isArray(raw.groups)
    ? raw.groups.flatMap((group) => {
        if (!group || typeof group !== "object") return [];
        const item = group as Record<string, unknown>;
        const groupId = Number(item.id);
        const name = String(item.name || "").trim();
        return Number.isInteger(groupId) && name ? [{ id: groupId, name }] : [];
      })
    : [];
  const images = Array.isArray(raw.images)
    ? raw.images.flatMap((image) => {
        if (!image || typeof image !== "object") return [];
        const item = image as Record<string, unknown>;
        const imageId = Number(item.id);
        if (!Number.isInteger(imageId)) return [];
        return [{
          id: imageId,
          thumbnail_data_url: typeof item.thumbnail_data_url === "string" ? item.thumbnail_data_url : undefined,
          width: Number(item.width) || null,
          height: Number(item.height) || null,
        }];
      })
    : [];
  return {
    id,
    kind,
    title: String(raw.title || "未命名"),
    content: String(raw.content || ""),
    negative_prompt: String(raw.negative_prompt || ""),
    category: String(raw.category || "未分类"),
    style: String(raw.style || ""),
    rating: Number.isFinite(rating) ? rating : null,
    rating_value: Number.isFinite(rating) ? Number(rating) / 2 : null,
    favorite: raw.favorite ? 1 : 0,
    pinned: raw.pinned ? 1 : 0,
    manual_order: Number(raw.manual_order) || 0,
    usage_count: Number(raw.usage_count) || 0,
    last_used_at: typeof raw.last_used_at === "string" ? raw.last_used_at : null,
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean) : [],
    groups,
    images,
  };
}

export async function importMobileLibraryPayload(payload: MobileLibraryPayload): Promise<number> {
  if (!Array.isArray(payload.entries)) throw new Error("文件中没有可识别的资料库卡片");
  const entries = payload.entries.map(sanitizeEntry).filter((entry): entry is MobileLibraryEntry => Boolean(entry));
  if (!entries.length) throw new Error("资料库文件中没有有效卡片");
  const db = await openDB();
  const existingEntries = await requestResult(
    db.transaction(STORE, "readonly").objectStore(STORE).getAll() as IDBRequest<MobileLibraryEntry[]>,
  );
  const existingById = new Map(existingEntries.map((entry) => [entry.id, entry]));
  const incomingThumbnails = new Map<number, string>();
  entries.forEach((entry) => entry.images.forEach((image) => {
    if (image.thumbnail_data_url) incomingThumbnails.set(image.id, image.thumbnail_data_url);
  }));

  const transaction = db.transaction([STORE, THUMBNAILS_STORE, META_STORE], "readwrite");
  const store = transaction.objectStore(STORE);
  const thumbnails = transaction.objectStore(THUMBNAILS_STORE);
  entries.forEach((entry) => {
    const lightweight = withoutEmbeddedThumbnails(entry);
    if (JSON.stringify(existingById.get(entry.id)) !== JSON.stringify(lightweight)) store.put(lightweight);
    existingById.set(entry.id, lightweight);
  });
  incomingThumbnails.forEach((dataUrl, id) => thumbnails.put({ id, data_url: dataUrl }));
  transaction.objectStore(META_STORE).put({ key: "navigation", value: buildNavigation([...existingById.values()]) });
  await transactionDone(transaction);
  db.close();
  return entries.length;
}

export async function importMobileLibraryFile(file: File): Promise<number> {
  return importMobileLibraryPayload(JSON.parse(await file.text()) as MobileLibraryPayload);
}

export async function loadMobileEntries(kind?: MobileLibraryKind): Promise<MobileLibraryEntry[]> {
  const db = await openDB();
  const store = db.transaction(STORE, "readonly").objectStore(STORE);
  const request = kind ? store.index("kind").getAll(IDBKeyRange.only(kind)) : store.getAll();
  const entries = await requestResult(request as IDBRequest<MobileLibraryEntry[]>);
  db.close();
  return entries;
}

function emptyRatings(): MobileRatingCounts {
  return { all_count: 0, at_least_9: 0, exactly_8: 0, between_6_and_7: 0, at_most_5: 0, unrated: 0 };
}

function addRating(counts: MobileRatingCounts, rating: number | null) {
  counts.all_count += 1;
  if (rating === null) counts.unrated += 1;
  else if (rating >= 9) counts.at_least_9 += 1;
  else if (rating === 8) counts.exactly_8 += 1;
  else if (rating >= 6) counts.between_6_and_7 += 1;
  else counts.at_most_5 += 1;
}

function buildNavigation(entries: MobileLibraryEntry[]): MobileNavigation {
  const totals = { artist: 0, prompt: 0 };
  const categoryMaps = { artist: new Map<string, number>(), prompt: new Map<string, number>() };
  const groupMaps = { artist: new Map<number, MobileLibraryGroup>(), prompt: new Map<number, MobileLibraryGroup>() };
  const ratings = emptyRatings();
  const styles = new Map<string, MobileStyleCounts>();

  entries.forEach((entry) => {
    totals[entry.kind] += 1;
    const parts = entry.category.split("/").filter(Boolean);
    if (!parts.length) parts.push("未分类");
    parts.forEach((_, index) => {
      const path = parts.slice(0, index + 1).join("/");
      categoryMaps[entry.kind].set(path, (categoryMaps[entry.kind].get(path) || 0) + 1);
    });
    entry.groups.forEach((group) => {
      const current = groupMaps[entry.kind].get(group.id) || { ...group, kind: entry.kind, count: 0 };
      current.count += 1;
      groupMaps[entry.kind].set(group.id, current);
    });
    if (entry.kind === "artist") {
      addRating(ratings, entry.rating);
      const name = entry.style.trim();
      const current = styles.get(name) || { name, ...emptyRatings() };
      addRating(current, entry.rating);
      styles.set(name, current);
    }
  });

  const categories = (kind: MobileLibraryKind) => [...categoryMaps[kind]]
    .map(([name, count]) => ({ name, count, sort_order: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  const groups = (kind: MobileLibraryKind) => [...groupMaps[kind].values()]
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
  return {
    totals,
    categories: { artist: categories("artist"), prompt: categories("prompt") },
    groups: { artist: groups("artist"), prompt: groups("prompt") },
    ratings,
    styles: [...styles.values()].sort((a, b) => {
      if (!a.name) return 1;
      if (!b.name) return -1;
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
    }),
  };
}

export async function getMobileNavigation(): Promise<MobileNavigation> {
  const db = await openDB();
  const cached = await requestResult(
    db.transaction(META_STORE, "readonly").objectStore(META_STORE).get("navigation") as IDBRequest<{ key: string; value: MobileNavigation } | undefined>,
  );
  db.close();
  if (cached?.value) return cached.value;
  const navigation = buildNavigation(await loadMobileEntries());
  const writeDb = await openDB();
  const transaction = writeDb.transaction(META_STORE, "readwrite");
  transaction.objectStore(META_STORE).put({ key: "navigation", value: navigation });
  await transactionDone(transaction);
  writeDb.close();
  return navigation;
}

function timeValue(value?: string | null) {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function queryMobileLibrary(params: URLSearchParams) {
  const kind: MobileLibraryKind = params.get("kind") === "prompt" ? "prompt" : "artist";
  const query = (params.get("q") || "").trim().toLocaleLowerCase();
  const category = (params.get("category") || "").trim();
  const groupId = Number(params.get("group_id")) || 0;
  const ratingMin = params.has("rating_min") ? Number(params.get("rating_min")) : null;
  const ratings = normalizeRatingFilter(params.get("ratings"));
  const ratingMax = params.has("rating_max") ? Number(params.get("rating_max")) : null;
  const unratedOnly = params.get("unrated_only") === "1";
  const style = (params.get("style") || "").trim();
  const styleUnclassified = params.get("style_unclassified") === "1";
  const sort = params.get("sort") || (kind === "artist" ? "rating_desc" : "usage_desc");
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const limit = Math.min(1000, Math.max(1, Number(params.get("limit")) || 60));

  const entries = (await loadMobileEntries(kind)).filter((entry) => {
    if (category && entry.category !== category && !entry.category.startsWith(`${category}/`)) return false;
    if (groupId && !entry.groups.some((group) => group.id === groupId)) return false;
    if (!ratingMatches(ratings, entry.rating)) return false;
    if (!ratings && (unratedOnly ? entry.rating !== null : entry.rating === null && (ratingMin !== null || ratingMax !== null))) return false;
    if (!ratings && !unratedOnly && ratingMin !== null && Number(entry.rating) < ratingMin) return false;
    if (!ratings && !unratedOnly && ratingMax !== null && Number(entry.rating) > ratingMax) return false;
    if (styleUnclassified && entry.style.trim()) return false;
    if (style && entry.style !== style) return false;
    if (query) {
      const haystack = [entry.title, entry.content, entry.negative_prompt, entry.category, entry.style, entry.tags.join(" ")]
        .join("\n").toLocaleLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  entries.sort((a, b) => {
    if (sort === "manual") return (a.manual_order || Number.MAX_SAFE_INTEGER) - (b.manual_order || Number.MAX_SAFE_INTEGER);
    if (sort === "usage_desc") return b.usage_count - a.usage_count || timeValue(b.last_used_at) - timeValue(a.last_used_at);
    if (sort === "newest") return timeValue(b.updated_at) - timeValue(a.updated_at);
    if (sort === "created_desc") return timeValue(b.created_at) - timeValue(a.created_at) || b.id - a.id;
    if (sort === "title") return a.title.localeCompare(b.title, "zh-CN", { numeric: true });
    const aRating = a.rating ?? (sort === "rating_asc" ? Number.MAX_SAFE_INTEGER : -1);
    const bRating = b.rating ?? (sort === "rating_asc" ? Number.MAX_SAFE_INTEGER : -1);
    return sort === "rating_asc" ? aRating - bRating : bRating - aRating;
  });
  const page = entries.slice(offset, offset + limit);
  const db = await openDB();
  const thumbnailStore = db.transaction(THUMBNAILS_STORE, "readonly").objectStore(THUMBNAILS_STORE);
  const hydrated = await Promise.all(page.map(async (entry) => {
    const cover = entry.images[0];
    if (!cover) return entry;
    const thumbnail = await requestResult(
      thumbnailStore.get(cover.id) as IDBRequest<{ id: number; data_url: string } | undefined>,
    );
    return thumbnail?.data_url
      ? { ...entry, images: [{ ...cover, thumbnail_data_url: thumbnail.data_url }, ...entry.images.slice(1)] }
      : entry;
  }));
  db.close();
  return { entries: hydrated, total: entries.length };
}

export async function recordMobileEntryUse(id: number) {
  const db = await openDB();
  const readTransaction = db.transaction(STORE, "readonly");
  const store = readTransaction.objectStore(STORE);
  const entry = await new Promise<MobileLibraryEntry | undefined>((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result as MobileLibraryEntry | undefined);
    request.onerror = () => reject(request.error);
  });
  await transactionDone(readTransaction);
  if (entry) {
    const writeTransaction = db.transaction(STORE, "readwrite");
    writeTransaction.objectStore(STORE).put({
      ...entry,
      usage_count: entry.usage_count + 1,
      last_used_at: new Date().toISOString(),
    });
    await transactionDone(writeTransaction);
  }
  db.close();
}
