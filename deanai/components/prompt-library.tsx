"use client";
import { RATING_CHOICES, normalizeRatingFilter, ratingLabel } from "@/lib/rating-filter";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, ExternalLink, FileUp, FolderTree, ImageIcon, ListFilter, LocateFixed, Search, Star, Tags } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Segmented } from "@/components/ui/segmented";
import {
  getMobileNavigation,
  importMobileLibraryPayload,
  queryMobileLibrary,
  recordMobileEntryUse,
} from "@/lib/db/mobile-library";
import { importMobileExternalLibrary } from "@/lib/db/mobile-external-library";
import { ExternalLibraryPicker } from "@/components/external-library-picker";
import { useAppPreferences } from "@/lib/use-app-preferences";
import { externalCharacterPrompts, externalFullPrompt, type ExternalEntry } from "@/lib/external-library";
import { navigateDesktopWorkspace } from "@/lib/workspace-navigation";

type LibraryKind = "artist" | "prompt";
type LibraryImage = { id: number; thumbnail_data_url?: string };
type LibraryEntry = {
  id: number;
  kind: LibraryKind;
  title: string;
  content: string;
  negative_prompt: string;
  category: string;
  style: string;
  rating: number | null;
  rating_value: number | null;
  favorite: number;
  usage_count: number;
  tags: string[];
  images: LibraryImage[];
};
type LibraryCategory = { name: string; count: number; sort_order: number };
type LibraryGroup = { id: number; kind: LibraryKind; name: string; count: number };
type NavigationData = {
  categories: Record<LibraryKind, LibraryCategory[]>;
  groups: Record<LibraryKind, LibraryGroup[]>;
  totals?: Record<LibraryKind, number>;
  ratings?: {
    all_count: number;
    at_least_9: number;
    exactly_8: number;
    between_6_and_7: number;
    at_most_5: number;
    unrated: number;
  };
  styles?: Array<{
    name: string;
    all_count: number;
    at_least_9: number;
    exactly_8: number;
    between_6_and_7: number;
    at_most_5: number;
    unrated: number;
  }>;
};
type RatingFilter = string;
type KindFilter = {
  category: string;
  groupId: string;
  categoryBeforeGroup: string;
  rating: RatingFilter;
  style: string;
  styleUnclassified: boolean;
  classificationView: "rating-first" | "style-first";
};
type SavedFilters = Record<LibraryKind, KindFilter>;
type LibrarySort = "rating_desc" | "rating_asc" | "usage_desc" | "manual" | "newest" | "created_desc" | "title";
type SavedSorts = Record<LibraryKind, LibrarySort>;

const FILTERS_KEY = "nyanovel-library-filters-v1";
const SORTS_KEY = "nyanovel-library-sorts-v1";
const SCROLL_POSITIONS_KEY = "nyanovel-library-scroll-positions-v1";
const DIRECTORY_STATE_KEY = "deanai-prompt-library-directory-state-v1";
const IS_STATIC_PWA = process.env.NEXT_PUBLIC_STATIC_PWA === "1";
const LIBRARY_MANAGE_URL = process.env.NEXT_PUBLIC_LOCAL_DESKTOP === "1" ? "/library" : "http://127.0.0.1:5179";
const PAGE_SIZE = IS_STATIC_PWA ? 24 : 60;
const EMPTY_FILTERS: SavedFilters = {
  artist: { category: "", groupId: "", categoryBeforeGroup: "", rating: "", style: "", styleUnclassified: false, classificationView: "rating-first" },
  prompt: { category: "", groupId: "", categoryBeforeGroup: "", rating: "", style: "", styleUnclassified: false, classificationView: "rating-first" },
};
const DEFAULT_SORTS: SavedSorts = { artist: "rating_desc", prompt: "usage_desc" };
const LIBRARY_CACHE_TTL = 30_000;
let navigationCache: { value: NavigationData; savedAt: number } | null = null;
const entriesCache = new Map<string, { entries: LibraryEntry[]; total: number; savedAt: number }>();

function loadSavedSorts(): SavedSorts {
  if (typeof window === "undefined") return DEFAULT_SORTS;
  try {
    const saved = JSON.parse(window.localStorage.getItem(SORTS_KEY) || "null") as Partial<SavedSorts> | null;
    const allowed = new Set<LibrarySort>(["rating_desc", "rating_asc", "usage_desc", "manual", "newest", "created_desc", "title"]);
    const promptAllowed = new Set<LibrarySort>(["usage_desc", "manual", "newest", "created_desc", "title"]);
    return {
      artist: saved?.artist && allowed.has(saved.artist) ? saved.artist : DEFAULT_SORTS.artist,
      prompt: saved?.prompt && promptAllowed.has(saved.prompt) ? saved.prompt : DEFAULT_SORTS.prompt,
    };
  } catch {
    return DEFAULT_SORTS;
  }
}

function loadSavedScrollPositions(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const saved = JSON.parse(window.localStorage.getItem(SCROLL_POSITIONS_KEY) || "null") as Record<string, unknown> | null;
    if (!saved) return {};
    return Object.fromEntries(
      Object.entries(saved)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
        .map(([key, value]) => [key, Math.max(0, value)]),
    );
  } catch {
    return {};
  }
}

function persistScrollPosition(key: string, value: number) {
  const latest = loadSavedScrollPositions();
  latest[key] = Math.max(0, value);
  window.localStorage.setItem(SCROLL_POSITIONS_KEY, JSON.stringify(latest));
}

type DirectoryState = {
  collapsed: Record<LibraryKind, string[]>;
  scroll: Record<LibraryKind, number>;
};

function loadDirectoryState(): DirectoryState {
  const fallback: DirectoryState = { collapsed: { artist: [], prompt: [] }, scroll: { artist: 0, prompt: 0 } };
  if (typeof window === "undefined") return fallback;
  try {
    const saved = JSON.parse(window.localStorage.getItem(DIRECTORY_STATE_KEY) || "null") as Partial<DirectoryState> | null;
    return {
      collapsed: {
        artist: Array.isArray(saved?.collapsed?.artist) ? saved.collapsed.artist.map(String) : [],
        prompt: Array.isArray(saved?.collapsed?.prompt) ? saved.collapsed.prompt.map(String) : [],
      },
      scroll: {
        artist: Math.max(0, Number(saved?.scroll?.artist) || 0),
        prompt: Math.max(0, Number(saved?.scroll?.prompt) || 0),
      },
    };
  } catch {
    return fallback;
  }
}

function persistDirectoryState(state: DirectoryState) {
  window.localStorage.setItem(DIRECTORY_STATE_KEY, JSON.stringify(state));
}

function loadSavedFilters(): SavedFilters {
  if (typeof window === "undefined") return EMPTY_FILTERS;
  try {
    const saved = JSON.parse(window.localStorage.getItem(FILTERS_KEY) || "null") as Partial<SavedFilters> | null;
    if (!saved) return EMPTY_FILTERS;
    const restore = (kind: LibraryKind): KindFilter => {
      const raw = saved[kind];
      const merged = { ...EMPTY_FILTERS[kind], ...raw };
      merged.rating = normalizeRatingFilter(merged.rating);
      if (merged.classificationView !== "style-first") merged.classificationView = "rating-first";
      merged.style = String(merged.style || "");
      merged.styleUnclassified = Boolean(merged.styleUnclassified);
      // Migrate preferences written before groups temporarily switched to all categories.
      const hasSavedReturnCategory = raw ? Object.prototype.hasOwnProperty.call(raw, "categoryBeforeGroup") : false;
      if (raw?.groupId && !hasSavedReturnCategory) {
        return { ...merged, category: "", categoryBeforeGroup: raw.category || "" };
      }
      return merged;
    };
    return { artist: restore("artist"), prompt: restore("prompt") };
  } catch {
    return EMPTY_FILTERS;
  }
}

function categoryLabel(name: string) {
  const parts = name.split("/").filter(Boolean);
  return parts.at(-1) || name;
}

function applyRatingFilter(params: URLSearchParams, kind: LibraryKind, rating: RatingFilter) {
  if (kind !== "artist") return;
  if (rating) params.set("ratings", normalizeRatingFilter(rating));
}

function applyStyleFilter(params: URLSearchParams, kind: LibraryKind, filter: KindFilter) {
  if (kind !== "artist") return;
  if (filter.styleUnclassified) params.set("style_unclassified", "1");
  else if (filter.style) params.set("style", filter.style);
}

export function PromptLibrary({ initialKind = "artist", compact = false }: { initialKind?: LibraryKind; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [librarySource, setLibrarySource] = useState<"local" | "external">("local");
  const [kind, setKind] = useState<LibraryKind>(initialKind);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [navigation, setNavigation] = useState<NavigationData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<SavedFilters>(loadSavedFilters);
  const [sorts, setSorts] = useState<SavedSorts>(loadSavedSorts);
  const [loadedListKey, setLoadedListKey] = useState("");
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const listRef = useRef<HTMLElement>(null);
  const directoryRef = useRef<HTMLElement>(null);
  const directoryScroll = useRef<Record<LibraryKind, number>>(loadDirectoryState().scroll);
  const importInputRef = useRef<HTMLInputElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});
  const activeListKeyRef = useRef("");
  const loadingMoreRef = useRef(false);
  const loadingMoreKeyRef = useRef("");
  const patchSettings = useStore((state) => state.patchSettings);

  const { preferences } = useAppPreferences();
  useEffect(() => {
    window.localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  }, [filters]);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<LibraryKind, string[]>>(() => loadDirectoryState().collapsed);

  useEffect(() => {
    window.localStorage.setItem(SORTS_KEY, JSON.stringify(sorts));
  }, [sorts]);
  useEffect(() => {
    persistDirectoryState({ collapsed: collapsedCategories, scroll: directoryScroll.current });
  }, [collapsedCategories]);

  useEffect(() => {
    if (!open || !navigation || !directoryRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (directoryRef.current) directoryRef.current.scrollTop = directoryScroll.current[kind] || 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [kind, navigation, open]);

  useEffect(() => {
    if (!open) return;
    if (navigationCache && Date.now() - navigationCache.savedAt < LIBRARY_CACHE_TTL) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled || !navigationCache) return;
        setNavigation(navigationCache.value);
        setError(null);
      });
      return () => { cancelled = true; };
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const data = IS_STATIC_PWA
          ? await getMobileNavigation()
          : await fetch("/api/library/navigation", { signal: controller.signal }).then(async (response) => {
              const payload = (await response.json()) as NavigationData & { error?: string };
              if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
              return payload;
            });
        setNavigation(data);
        navigationCache = { value: data, savedAt: Date.now() };
        setError(null);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => controller.abort();
  }, [libraryRevision, open]);

  const activeFilter = filters[kind];
  const activeSort = sorts[kind];
  const categories = navigation?.categories[kind] || [];
  const categoryParents = useMemo(() => {
    const parents = new Set<string>();
    categories.forEach((category) => {
      const parts = category.name.split("/").filter(Boolean);
      for (let index = 1; index < parts.length; index += 1) {
        parents.add(parts.slice(0, index).join("/"));
      }
    });
    return parents;
  }, [categories]);
  const collapsedForKind = collapsedCategories[kind];
  const visibleCategories = useMemo(() => {
    if (collapsedForKind.includes("__root__")) return [];
    const collapsed = new Set(collapsedForKind);
    return categories.filter((category) => {
      const parts = category.name.split("/").filter(Boolean);
      for (let index = 1; index < parts.length; index += 1) {
        if (collapsed.has(parts.slice(0, index).join("/"))) return false;
      }
      return true;
    });
  }, [categories, collapsedForKind]);
  const groups = navigation?.groups[kind] || [];
  const styles = navigation?.styles || [];
  const activeListKey = JSON.stringify([kind, activeFilter.category, activeFilter.groupId, activeFilter.rating, activeFilter.style, activeFilter.styleUnclassified, query, activeSort]);

  useEffect(() => {
    activeListKeyRef.current = activeListKey;
  }, [activeListKey]);

  useEffect(() => {
    const persistCurrent = () => {
      const key = activeListKeyRef.current;
      if (key) persistScrollPosition(key, scrollPositions.current[key] || 0);
    };
    window.addEventListener("pagehide", persistCurrent);
    return () => window.removeEventListener("pagehide", persistCurrent);
  }, []);

  useEffect(() => {
    if (!open) return;
    const cached = entriesCache.get(activeListKey);
    if (cached && Date.now() - cached.savedAt < LIBRARY_CACHE_TTL) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        setEntries(cached.entries);
        setTotal(cached.total);
        setLoadedListKey(activeListKey);
        setLoading(false);
        setError(null);
      });
      return () => { cancelled = true; };
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        loadingMoreRef.current = false;
        loadingMoreKeyRef.current = "";
        setLoadingMore(false);
        const params = new URLSearchParams({ kind, q: query, limit: String(PAGE_SIZE), offset: "0", sort: activeSort });
        if (activeFilter.category) {
          params.set(IS_STATIC_PWA ? "category" : "category_prefix", activeFilter.category);
        }
        if (activeFilter.groupId) params.set("group_id", activeFilter.groupId);
        applyRatingFilter(params, kind, activeFilter.rating);
        applyStyleFilter(params, kind, activeFilter);
        const data = IS_STATIC_PWA
          ? await queryMobileLibrary(params)
          : await fetch(`/api/library/entries?${params}`, { signal: controller.signal }).then(async (response) => {
              const payload = (await response.json()) as { entries?: LibraryEntry[]; total?: number; error?: string };
              if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
              return payload;
            });
        setEntries(data.entries || []);
        setTotal(data.total || 0);
        entriesCache.set(activeListKey, { entries: data.entries || [], total: data.total || 0, savedAt: Date.now() });
        setLoadedListKey(activeListKey);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setEntries([]);
        setTotal(0);
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeFilter, activeListKey, activeSort, kind, libraryRevision, open, query]);

  useEffect(() => {
    if (!open || loadedListKey !== activeListKey) return;
    const frame = window.requestAnimationFrame(() => {
      if (listRef.current) {
        const latest = loadSavedScrollPositions();
        const saved = latest[activeListKey] ?? scrollPositions.current[activeListKey] ?? 0;
        scrollPositions.current[activeListKey] = saved;
        listRef.current.scrollTop = saved;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeListKey, loadedListKey, open]);

  const countLabel = useMemo(() => {
    if (loading) return "读取中…";
    if (error) return "未连接";
    return `显示 ${entries.length} / ${total}`;
  }, [entries.length, error, loading, total]);

  const rememberCurrentPosition = () => {
    const position = listRef.current?.scrollTop ?? scrollPositions.current[activeListKey] ?? 0;
    scrollPositions.current[activeListKey] = position;
    persistScrollPosition(activeListKey, position);
  };

  const loadMore = useCallback(async () => {
    if (loading || loadedListKey !== activeListKey || loadingMoreRef.current || entries.length >= total) return;
    const requestKey = activeListKey;
    loadingMoreRef.current = true;
    loadingMoreKeyRef.current = requestKey;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        kind,
        q: query,
        limit: String(PAGE_SIZE),
        offset: String(entries.length),
        sort: activeSort,
      });
      if (activeFilter.category) {
        params.set(IS_STATIC_PWA ? "category" : "category_prefix", activeFilter.category);
      }
      if (activeFilter.groupId) params.set("group_id", activeFilter.groupId);
      applyRatingFilter(params, kind, activeFilter.rating);
      applyStyleFilter(params, kind, activeFilter);
      const data = IS_STATIC_PWA
        ? await queryMobileLibrary(params)
        : await fetch(`/api/library/entries?${params}`).then(async (response) => {
            const payload = (await response.json()) as { entries?: LibraryEntry[]; total?: number; error?: string };
            if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
            return payload;
          });
      if (activeListKeyRef.current !== requestKey) return;
      setEntries((current) => {
        const existing = new Set(current.map((entry) => entry.id));
        return [...current, ...(data.entries || []).filter((entry) => !existing.has(entry.id))];
      });
      setTotal(data.total || 0);
    } catch (reason) {
      if (activeListKeyRef.current === requestKey) {
        toast.error(`加载更多失败：${reason instanceof Error ? reason.message : String(reason)}`);
      }
    } finally {
      if (loadingMoreKeyRef.current === requestKey) {
        loadingMoreRef.current = false;
        loadingMoreKeyRef.current = "";
        if (activeListKeyRef.current === requestKey) setLoadingMore(false);
      }
    }
  }, [activeFilter, activeListKey, activeSort, entries.length, kind, loadedListKey, loading, query, total]);

  const updateFilter = (patch: Partial<KindFilter>) => {
    rememberCurrentPosition();
    setFilters(() => {
      const latest = loadSavedFilters();
      return {
        ...latest,
        [kind]: { ...latest[kind], ...patch },
      };
    });
  };

  const changeSort = (sort: LibrarySort) => {
    if (sort === activeSort) return;
    rememberCurrentPosition();
    setSorts(() => ({ ...loadSavedSorts(), [kind]: sort }));
  };

  const selectGroup = (groupId: string) => {
    rememberCurrentPosition();
    setFilters(() => {
      const latest = loadSavedFilters();
      const current = latest[kind];
      const next = groupId
        ? {
            ...current,
            groupId,
            category: "",
            categoryBeforeGroup: current.groupId ? current.categoryBeforeGroup : current.category,
          }
        : {
            ...current,
            groupId: "",
            category: current.categoryBeforeGroup,
            categoryBeforeGroup: "",
          };
      return { ...latest, [kind]: next };
    });
  };

  const replace = (entry: LibraryEntry, includeNegative: boolean) => {
    const positiveField = entry.kind === "artist" ? "artistPrompt" : "scenePrompt";
    const nameField = entry.kind === "artist" ? "artistPromptName" : "scenePromptName";
    patchSettings({
      [positiveField]: entry.content.trim(),
      [nameField]: entry.title.trim(),
      ...(includeNegative && entry.negative_prompt
        ? { negativePrompt: entry.negative_prompt.trim() }
        : {}),
    });
    rememberCurrentPosition();
    entriesCache.delete(activeListKey);
    setOpen(false);
    if (IS_STATIC_PWA) {
      void recordMobileEntryUse(entry.id).catch(() => {});
    } else {
      void fetch(`/api/library/entries/${entry.id}/use`, { method: "POST", keepalive: true }).catch(() => {
        // Replacing the prompt is the primary action; usage analytics must not block it.
      });
    }
  };

  const locateEntry = (entry: LibraryEntry) => {
    rememberCurrentPosition();
    setOpen(false);
    const embeddedUrl = `/library-embed/?focus_entry=${entry.id}`;
    if (!navigateDesktopWorkspace("library", embeddedUrl)) {
      window.open(`${LIBRARY_MANAGE_URL}?focus_entry=${entry.id}`, "nai-artist-library");
    }
  };

  const filterButton = (selected: boolean) =>
    cn(
      "flex w-full items-center justify-between gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12px] transition-colors",
      selected ? "bg-accent/15 font-semibold text-accent" : "text-fg-2 hover:bg-surface-3 hover:text-fg",
    );


  const toggleCategoryCollapsed = (path: string) => {
    setCollapsedCategories((current) => {
      const paths = new Set(current[kind]);
      if (paths.has(path)) paths.delete(path);
      else paths.add(path);
      return { ...current, [kind]: [...paths] };
    });
  };
  const groupButton = (selected: boolean) =>
    cn(
      "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11.5px] font-medium transition-colors",
      selected
        ? "border-accent/45 bg-accent/15 text-accent"
        : "border-border-soft bg-surface-2 text-fg-2 hover:border-border hover:bg-surface-3 hover:text-fg",
    );

  const classificationFilters = [
    <div key="rating" className="grid gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted">评分</span>
      <details className="rounded-lg border border-border-soft bg-surface-2 p-2">
        <summary className="cursor-pointer text-sm">{activeFilter.rating ? activeFilter.rating.split(",").map(ratingLabel).join("、") : "全部评分"}（多选）</summary>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <button type="button" className="col-span-2 rounded border border-border p-1" onClick={() => updateFilter({ rating: "" })}>全部评分 / 清除筛选</button>
          {RATING_CHOICES.map((value) => <label key={value} className="flex items-center gap-2"><input type="checkbox" checked={activeFilter.rating.split(",").includes(value)} onChange={(event) => updateFilter({ rating: normalizeRatingFilter((event.target.checked ? [...activeFilter.rating.split(","), value] : activeFilter.rating.split(",").filter((item) => item !== value)).join(",")) })} />{ratingLabel(value)}</label>)}
        </div>
      </details>
    </div>,
    <div key="style" className="grid gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted">风格</span>
      <Select
        value={activeFilter.styleUnclassified ? "unclassified" : (activeFilter.style ? `style:${activeFilter.style}` : "")}
        onChange={(event) => updateFilter({
          styleUnclassified: event.target.value === "unclassified",
          style: event.target.value.startsWith("style:") ? event.target.value.slice(6) : "",
        })}
        aria-label="按风格筛选画师串"
      >
        <option value="">全部风格</option>
        {styles.map((style) => (
          <option key={style.name || "unclassified"} value={style.name ? `style:${style.name}` : "unclassified"}>
            {style.name || "未分类风格"}
          </option>
        ))}
      </Select>
    </div>,
  ];
  if (activeFilter.classificationView === "style-first") classificationFilters.reverse();

  const openLibrary = () => {
    scrollPositions.current = loadSavedScrollPositions();
    const directoryState = loadDirectoryState();
    directoryScroll.current = directoryState.scroll;
    setCollapsedCategories(directoryState.collapsed);
    setFilters(loadSavedFilters());
    setSorts(loadSavedSorts());
    setLibrarySource("local");
    setKind(initialKind);
    setOpen(true);
  };

  const closeLibrary = () => {
    rememberCurrentPosition();
    setOpen(false);
  };

  const changeKind = (nextKind: LibraryKind) => {
    if (nextKind === kind) return;
    rememberCurrentPosition();
    setKind(nextKind);
  };

  const changeQuery = (nextQuery: string) => {
    rememberCurrentPosition();
    setQuery(nextQuery);

  };

  const useExternalEntry = (entry: ExternalEntry, includeNegative: boolean, mode: "scene" | "characters" = "scene") => {
    const characters = externalCharacterPrompts(entry);
    patchSettings({
      scenePrompt: mode === "scene" ? externalFullPrompt(entry) : entry.prompt.trim(),
      scenePromptName: entry.title.trim() || "外置资料",
      ...(mode === "characters" ? {
        characters: characters.map((item) => ({
          prompt: item.prompt, uc: item.negative_prompt,
          center: { x: 0.5, y: 0.5 }, enabled: true,
        })),
      } : {}),
      ...(includeNegative && entry.negative_prompt ? { negativePrompt: entry.negative_prompt.trim() } : {}),
    });
    toast.success(mode === "characters" ? "主提示词已放入场景，角色词已拆分" : "完整提示词已放入场景");
    setOpen(false);
  };
  const importMobileFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as { entries?: unknown[]; external_sources?: unknown[]; external_entries?: unknown[] };
      const localCount = Array.isArray(payload.entries) && payload.entries.length
        ? await importMobileLibraryPayload(payload) : 0;
      const externalCount = await importMobileExternalLibrary(payload);
      if (!localCount && !externalCount) {
        if (Array.isArray(payload.entries) || Array.isArray(payload.external_entries)) { toast.info("资料已是最新，没有需要合并的条目"); return; }
        else throw new Error("资料包中没有可导入的本地或外置资料");
      }
      if (navigator.storage?.persist) void navigator.storage.persist();
      navigationCache = null;
      entriesCache.clear();
      setLibraryRevision((value) => value + 1);
      toast.success(`增量导入完成：本地 ${localCount} 条，外置 ${externalCount} 条`);    } catch (reason) {
      toast.error(`导入资料库失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  return (
    <>
      {compact ? (
        <IconButton
          size="sm"
          variant="subtle"
          className="size-7"
          label={initialKind === "artist" ? "从资料库替换画师串" : "从资料库替换场景提示词"}
          onClick={openLibrary}
        >
          <BookOpen />
        </IconButton>
      ) : (
        <Button variant="outline" size="sm" onClick={openLibrary} title="从本地资料库选择提示词">
          <BookOpen className="size-3.5" /> 资料库
        </Button>
      )}
      <Modal
        open={open}
        onClose={closeLibrary}
        title={(
          <span className="flex w-full items-end justify-between gap-3">
            <span>{"\u63d0\u793a\u8bcd\u8d44\u6599\u5e93"}</span>
            <span className="shrink-0 pb-0.5 font-sans text-[10px] font-normal tracking-normal text-muted sm:text-[11px]">
              {librarySource === "external" ? "\u5916\u7f6e\u8d44\u6599\u4f1a\u5199\u5165\u573a\u666f\u63d0\u793a\u8bcd" : "\u70b9\u51fb\u5361\u7247\u5373\u53ef\u66ff\u6362"}
            </span>
          </span>
        )}
        className="flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none flex-col overflow-hidden rounded-[14px] p-3 sm:h-[min(88vh,900px)] sm:w-[min(96vw,1400px)] sm:rounded-[var(--radius-card-lg)] sm:p-6"
      >
        {preferences.showExternalLibraryInPicker && <div className="mb-2 shrink-0 border-b border-border-soft pb-2">
          <Segmented
            options={[
              { value: "local", label: "\u672c\u5730\u8d44\u6599\u5e93" },
              { value: "external", label: "\u5916\u7f6e\u8d44\u6599\u5e93" },
            ]}
            value={librarySource}
            onValueChange={(value) => setLibrarySource(value === "external" ? "external" : "local")}
            className="w-full sm:w-[360px]"
          />
        </div>}
        {librarySource === "external" && preferences.showExternalLibraryInPicker
          ? <ExternalLibraryPicker onUse={useExternalEntry} /> : <>
        <div className="shrink-0 pb-2 md:hidden">
          <div className="flex items-center gap-1.5">
            <Segmented
              options={[
                { value: "artist", label: "画师串" },
                { value: "prompt", label: "场景提示词" },
              ]}
              value={kind}
              onValueChange={(value) => changeKind(value as LibraryKind)}
              className="min-w-0 flex-1"
            />
            <IconButton
              size="md"
              variant={mobileSearchOpen ? "accent" : "subtle"}
              className="border border-border-soft"
              label={mobileSearchOpen ? "收起搜索" : "搜索资料库"}
              aria-expanded={mobileSearchOpen}
              onClick={() => setMobileSearchOpen((value) => !value)}
            >
              <Search />
            </IconButton>
            <IconButton
              size="md"
              variant={mobileFiltersOpen ? "accent" : "subtle"}
              className="border border-border-soft"
              label={mobileFiltersOpen ? "收起筛选" : "打开分类与筛选"}
              aria-expanded={mobileFiltersOpen}
              onClick={() => setMobileFiltersOpen((value) => !value)}
            >
              <ListFilter />
            </IconButton>
          </div>

          {mobileSearchOpen && (
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input
                value={query}
                onChange={(event) => changeQuery(event.target.value)}
                placeholder="搜索标题、提示词、分类或标签…"
                className="pl-9"
                autoFocus
              />
            </div>
          )}

          {mobileFiltersOpen && (
            <div className="mt-2 max-h-[48dvh] overflow-y-auto rounded-[10px] border border-border-soft bg-surface-2 p-2.5">
              <div className="grid grid-cols-2 gap-2">
                <Select
                  value={activeSort}
                  onChange={(event) => changeSort(event.target.value as LibrarySort)}
                  className="h-9 min-w-0 text-[12px]"
                  aria-label="资料库排序方式"
                >
                  {kind === "artist" && <option value="rating_desc">评分：高到低</option>}
                  {kind === "artist" && <option value="rating_asc">评分：低到高</option>}
                  <option value="usage_desc">使用次数：多到少</option>
                  <option value="manual">自定义顺序</option>
                  <option value="newest">最近更新</option>
                  <option value="created_desc">创建时间：新到旧</option>
                  <option value="title">名称排序</option>
                </Select>
                {IS_STATIC_PWA ? (
                  <Button className="min-w-0" variant="outline" size="sm" onClick={() => importInputRef.current?.click()}>
                    导入资料库 <FileUp className="size-3.5" />
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => window.open(LIBRARY_MANAGE_URL, "nai-artist-library")}>管理资料库</Button>
                )}
              </div>
              <p className="mt-1.5 text-[10.5px] text-muted">{countLabel}</p>

              <div className="mt-2 flex items-center gap-2 border-y border-border-soft py-2">
                <span className="flex shrink-0 items-center gap-1 text-[10px] font-bold text-muted"><Tags className="size-3" /> 分组</span>
                <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
                  <button className={groupButton(!activeFilter.groupId)} onClick={() => selectGroup("")}>全部分组</button>
                  {groups.map((group) => (
                    <button key={group.id} className={groupButton(activeFilter.groupId === String(group.id))} onClick={() => selectGroup(String(group.id))}>
                      <span>{group.name}</span><span className="text-[10px] text-muted">{group.count}</span>
                    </button>
                  ))}
                </div>
              </div>

              {kind === "artist" && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="col-span-2 grid gap-1">
                    <span className="text-[10px] font-bold text-muted">分类层级</span>
                    <Select value={activeFilter.classificationView} onChange={(event) => updateFilter({ classificationView: event.target.value === "style-first" ? "style-first" : "rating-first" })}>
                      <option value="rating-first">评分 → 风格</option>
                      <option value="style-first">风格 → 评分</option>
                    </Select>
                  </div>
                  {classificationFilters}
                </div>
              )}
              <div className="mt-2 grid gap-1">
                <span className="flex items-center gap-1 text-[10px] font-bold text-muted"><FolderTree className="size-3" /> 分类</span>
                <Select value={activeFilter.category} onChange={(event) => updateFilter({ category: event.target.value })} aria-label="资料库分类">
                  <option value="">全部分类 · {Number(navigation?.totals?.[kind] || 0)}</option>
                  {categories.map((category) => (
                    <option key={category.name} value={category.name}>{category.name} · {category.count}</option>
                  ))}
                </Select>
              </div>
            </div>
          )}
        </div>

        <div className="hidden shrink-0 pb-3 md:block">
          <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-3">
            <Segmented
              options={[
                { value: "artist", label: "画师串" },
                { value: "prompt", label: "场景提示词" },
              ]}
              value={kind}
              onValueChange={(value) => changeKind(value as LibraryKind)}
              className="col-span-2 shrink-0 sm:col-span-1"
            />
            <div className="relative col-span-2 min-w-0 flex-1 sm:col-span-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input
                value={query}
                onChange={(event) => changeQuery(event.target.value)}
                placeholder="在当前分类和分组中搜索…"
                className="pl-9"
                autoFocus
              />
            </div>
            <Select
              value={activeSort}
              onChange={(event) => changeSort(event.target.value as LibrarySort)}
              className="h-9 min-w-0 text-[12px] sm:min-w-36 sm:w-40"
              aria-label="资料库排序方式"
              title="资料库排序方式"
            >
              {kind === "artist" && <option value="rating_desc">评分：高到低</option>}
              {kind === "artist" && <option value="rating_asc">评分：低到高</option>}
              <option value="usage_desc">使用次数：多到少</option>
              <option value="manual">自定义顺序</option>
              <option value="newest">最近更新</option>
              <option value="created_desc">创建时间：新到旧</option>
              <option value="title">名称排序</option>
            </Select>
            {IS_STATIC_PWA ? (
              <>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(event) => void importMobileFile(event.target.files?.[0])}
                />
                <Button className="min-w-0" variant="outline" size="sm" onClick={() => importInputRef.current?.click()}>
                  导入资料库 <FileUp className="size-3.5" />
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => window.open(LIBRARY_MANAGE_URL, "nai-artist-library")}
                title="打开资料库管理页面"
              >
                管理 <ExternalLink className="size-3.5" />
              </Button>
            )}
          </div>
          <p className="mt-1.5 text-[11.5px] text-muted sm:mt-2">{countLabel}</p>
        </div>

        <div className="hidden shrink-0 items-center gap-2 border-y border-border-soft py-2.5 md:flex">
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
            <Tags className="size-3.5" /> 分组
          </span>
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto py-0.5 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]">
            <button className={groupButton(!activeFilter.groupId)} onClick={() => selectGroup("")}>
              全部分组
            </button>
            {groups.map((group) => (
              <button
                key={group.id}
                className={groupButton(activeFilter.groupId === String(group.id))}
                onClick={() => selectGroup(String(group.id))}
                title={group.name}
              >
                <span>{group.name}</span>
                <span className="text-[10px] text-muted">{group.count}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
          <aside
            ref={directoryRef}
            className="hidden w-60 shrink-0 overflow-y-auto border-r border-border-soft py-4 pr-2 md:block"
            onScroll={(event) => {
              directoryScroll.current[kind] = event.currentTarget.scrollTop;
              persistDirectoryState({ collapsed: collapsedCategories, scroll: directoryScroll.current });
            }}
          >
            {kind === "artist" && (
              <div className="mb-4 grid gap-3 border-b border-border-soft pb-4">
                <p className="flex items-center gap-2 px-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
                  <Star className="size-3.5" /> 画师串分类预演
                </p>
                <Select
                  value={activeFilter.classificationView}
                  onChange={(event) => updateFilter({
                    classificationView: event.target.value === "style-first" ? "style-first" : "rating-first",
                  })}
                  aria-label="画师串分类层级"
                >
                  <option value="rating-first">评分 → 风格</option>
                  <option value="style-first">风格 → 评分</option>
                </Select>
                {classificationFilters}
              </div>
            )}
            <div>
              <p className="mb-2 flex items-center gap-2 px-2.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
                <FolderTree className="size-3.5" /> 分类
              </p>
              <button className={filterButton(!activeFilter.category)} onClick={() => updateFilter({ category: "" })}>
                <span>全部分类</span>
                {navigation?.totals?.[kind] !== undefined && <span className="text-[10px] text-muted">{navigation.totals[kind]}</span>}
              </button>
              {visibleCategories.map((category) => {
                const depth = Math.max(0, category.name.split("/").filter(Boolean).length - 1);
                const hasChildren = categoryParents.has(category.name);
                const expanded = !collapsedForKind.includes(category.name);
                return (
                  <button
                    key={category.name}
                    className={filterButton(activeFilter.category === category.name)}
                    style={{ paddingLeft: 10 + depth * 12 }}
                    onClick={() => updateFilter({ category: category.name })}
                    title={category.name}
                  >
                    <span className="flex min-w-0 items-center">
                    {hasChildren ? (
                      <span
                        role="button"
                        tabIndex={0}
                        className="mr-1 grid size-5 shrink-0 place-items-center rounded text-muted hover:bg-surface-3 hover:text-fg"
                        title={expanded ? "\u6298\u53e0\u5b50\u5206\u7c7b" : "\u5c55\u5f00\u5b50\u5206\u7c7b"}
                        aria-label={expanded ? "\u6298\u53e0\u5b50\u5206\u7c7b" : "\u5c55\u5f00\u5b50\u5206\u7c7b"}
                        aria-expanded={expanded}
                        onClick={(event) => { event.stopPropagation(); toggleCategoryCollapsed(category.name); }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); toggleCategoryCollapsed(category.name); }
                        }}
                      >
                        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      </span>
                    ) : <span className="mr-1 size-5 shrink-0" />}
                    <span className="truncate">{categoryLabel(category.name)}</span>
                    </span>
                    <span className="shrink-0 text-[10px] text-muted">{category.count}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          <main
            ref={listRef}
            className="min-h-0 flex-1 overflow-y-auto pb-2 pt-2.5 md:py-4 md:pl-4"
            onScroll={(event) => {
              const element = event.currentTarget;
              scrollPositions.current[activeListKey] = element.scrollTop;
              if (element.scrollHeight - element.scrollTop - element.clientHeight < 360) {
                void loadMore();
              }
            }}
          >
            {error ? (
              <div className="rounded-[var(--radius-card)] border border-danger/35 bg-danger-bg/10 p-5 text-sm">
                <p className="font-semibold text-fg">资料库尚未启动</p>
                <p className="mt-1 text-muted">{error}</p>
                <p className="mt-3 text-[12px] text-muted">运行根目录的 start-local.bat，或先启动 nai-artist-library/start.bat。</p>
              </div>
            ) : loading && entries.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted">正在读取本地资料库…</div>
            ) : entries.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted">当前分类、分组和搜索条件下没有条目。</div>
            ) : (
              <>
                <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {entries.map((entry) => {
                  const image = entry.images[0];
                  const imageSource = image?.thumbnail_data_url || (!IS_STATIC_PWA && image ? `/api/library/assets/${image.id}` : "");
                  const ratingValue = entry.rating_value ?? (entry.rating ? entry.rating / 2 : null);
                  return (
                    <article key={entry.id} className="flex min-w-0 gap-2.5 rounded-[var(--radius-card)] border border-border-soft bg-surface-2 p-2.5 sm:gap-3 sm:p-3">
                      <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-[9px] bg-surface-3 text-muted">
                        {imageSource ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={imageSource} alt="" className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <ImageIcon className="size-5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="truncate text-[13.5px] font-semibold text-fg" title={entry.title}>{entry.title}</h3>
                            <p className="truncate text-[11px] text-muted" title={entry.category}>{entry.category || "未分类"}</p>
                            {entry.kind === "artist" && entry.style && (
                              <p className="truncate text-[10.5px] text-accent" title={`风格：${entry.style}`}>风格 · {entry.style}</p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {entry.kind === "artist" && (
                              <span
                                className={cn(
                                  "flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium",
                                  ratingValue === null ? "bg-surface-3 text-muted" : "bg-accent/12 text-accent",
                                )}
                                title={ratingValue === null ? "该画师串尚未评分" : `画师串评分 ${ratingValue} / 5`}
                              >
                                <Star className={cn("size-3", ratingValue !== null && "fill-current")} />
                                {ratingValue === null ? "未评分" : `评分 ${ratingValue}/5`}
                              </span>
                            )}
                            {!IS_STATIC_PWA && (
                              <IconButton
                                size="sm"
                                variant="subtle"
                                className="size-7"
                                label={`在资料库中定位：${entry.title}`}
                                onClick={() => locateEntry(entry)}
                              >
                                <LocateFixed />
                              </IconButton>
                            )}
                          </div>
                        </div>
                        <p className="mt-1.5 max-h-10 overflow-hidden text-[11.5px] leading-5 text-fg-2" title={entry.content}>
                          {entry.content || "（空 Prompt）"}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button size="sm" className="h-8 px-2.5 text-[12px]" disabled={!entry.content} onClick={() => replace(entry, false)}>
                            替换{entry.kind === "artist" ? "画师串" : "场景提示词"}
                          </Button>
                          {entry.negative_prompt && (
                            <Button variant="outline" size="sm" className="h-8 px-2.5 text-[12px]" onClick={() => replace(entry, true)}>
                              同时替换负面词
                            </Button>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                  })}
                </div>
                <div className="py-4 text-center text-[11.5px] text-muted">
                  {loadingMore
                    ? "正在加载更多…"
                    : entries.length < total
                      ? "继续向下滚动以加载更多"
                      : `已加载全部 ${entries.length} 条`}
                </div>
              </>
            )}
          </main>
        </div>
        </>}
      </Modal>
    </>
  );
}
