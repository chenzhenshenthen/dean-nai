"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, CalendarRange, CheckSquare, ChevronLeft, ChevronRight, Clipboard, Columns3, Copy, Eye, EyeOff, FolderSearch, Heart, ImagePlus, ListChecks, RefreshCw, RotateCcw, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { FeatureShell } from "@/components/feature-shell";
import { DesktopFullscreenButton } from "@/components/desktop-fullscreen-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { recipeFromMetadata, sendPromptToStudio, sendRecipeToStudio, type PortableMetadata } from "@/lib/gallery-recipe";
import { modelFromSource, modelLabel } from "@/lib/nai/models";
import { copyImageWithoutMetadata } from "@/lib/image-actions";
import { LOCAL_GALLERY_SHORTCUTS_EVENT, loadLocalGalleryShortcuts, matchesShortcut, type LocalGalleryShortcutAction, type LocalGalleryShortcuts } from "@/lib/local-gallery-shortcuts";

type LocalImage = {
  id: number; name: string; path: string; size: number; width: number; height: number;
  prompt: string; negative_prompt: string; metadata: PortableMetadata & Record<string, unknown>;
  modified_ns: number; media_type: "image" | "video";
};
type Filters = { exactDate: string; dateFrom: string; dateTo: string; model: string; sampler: string; orientation: string; resolution: string; stepsFrom: string; stepsTo: string; cfgFrom: string; cfgTo: string };
type HoverPreview = { image: LocalImage; left: number; top: number };

const FAVORITES_KEY = "dean-local-gallery-favorites-v1";
const COLLECTIONS_KEY = "dean-local-gallery-collections-v1";
const PRIVACY_KEY = "dean-local-gallery-privacy-v1";
const FILTERS_KEY = "dean-local-gallery-filters-v1";
const DEFAULT_PAGE_SIZE = 300;
const EMPTY_FILTERS: Filters = { exactDate: "", dateFrom: "", dateTo: "", model: "", sampler: "", orientation: "", resolution: "", stepsFrom: "", stepsTo: "", cfgFrom: "", cfgTo: "" };
const GALLERY_CACHE_TTL = 30_000;
type GalleryResponse = { images?: LocalImage[]; total?: number; page_size?: number; roots?: string[]; models?: string[]; samplers?: string[]; error?: string };
const galleryPageCache = new Map<string, { value: GalleryResponse; savedAt: number }>();

function mediaUrl(image: LocalImage) { return `/api/local-gallery/image/${image.id}`; }
function thumbnailUrl(image: LocalImage) { return `/api/local-gallery/thumbnail/${image.id}`; }
function formatBytes(bytes: number) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"]; let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
function imageFacts(image: LocalImage) {
  const metadata = image.metadata || {};
  const parameters = (metadata.parameters && typeof metadata.parameters === "object" ? metadata.parameters : metadata) as Record<string, unknown>;
  const sourceText = Object.values((metadata.raw_fields && typeof metadata.raw_fields === "object" ? metadata.raw_fields : {}) as Record<string, unknown>).join(" ");
  const model = String(parameters.model || metadata.model || modelFromSource(sourceText) || "");
  return {
    model: model ? modelLabel(model) : "无法从图片元数据识别",
    sampler: String(parameters.sampler || parameters.sampler_name || metadata.sampler || "未知"),
    seed: String(parameters.seed ?? metadata.seed ?? "未知"),
    steps: String(parameters.steps ?? metadata.steps ?? "未知"),
  };
}

function portableMetadata(image: LocalImage): PortableMetadata {
  return {
    ...(image.metadata || {}),
    positive_prompt: image.metadata?.positive_prompt || image.prompt || "",
    negative_prompt: image.metadata?.negative_prompt || image.negative_prompt || "",
  };
}

function Media({ image, thumbnail = false, className = "" }: { image: LocalImage; thumbnail?: boolean; className?: string }) {
  if (image.media_type === "video") {
    return <video src={mediaUrl(image)} muted playsInline preload="metadata" className={className} />;
  }
  return <img src={thumbnail ? thumbnailUrl(image) : mediaUrl(image)} alt={image.name} loading={thumbnail ? "lazy" : "eager"} className={className} />;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
function dateToIso(date: Date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}
function isoToDate(value: string) {
  if (!value) return null;
  const parts = value.split("-").map(Number);
  return parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2], 12) : null;
}
function monthOffset(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1, 12);
}
function MonthCalendar({ month, selected, rangeStart, rangeEnd, onPick }: { month: Date; selected?: string; rangeStart?: string; rangeEnd?: string; onPick: (value: string) => void }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const offset = (first.getDay() + 6) % 7;
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: offset + count }, (_, index) => index < offset ? null : new Date(month.getFullYear(), month.getMonth(), index - offset + 1, 12));
  const today = dateToIso(new Date());
  return <div className="min-w-0">
    <p className="mb-3 text-sm font-semibold">{month.getFullYear()}年{month.getMonth() + 1}月</p>
    <div className="grid grid-cols-7 text-center text-xs text-muted">{WEEKDAYS.map((day) => <span key={day} className="py-2">{day}</span>)}</div>
    <div className="grid grid-cols-7 gap-y-1">
      {cells.map((date, index) => {
        if (!date) return <span key={"blank-" + index} />;
        const iso = dateToIso(date);
        const active = iso === selected || iso === rangeStart || iso === rangeEnd;
        const inRange = Boolean(rangeStart && rangeEnd && iso > rangeStart && iso < rangeEnd);
        return <button key={iso} type="button" onClick={() => onPick(iso)} className={cn("h-10 text-sm transition hover:bg-accent/20", inRange && "bg-accent/20", active && "bg-accent font-semibold text-on-accent", iso === today && !active && "ring-1 ring-inset ring-accent")}>{date.getDate()}</button>;
      })}
    </div>
  </div>;
}

function DateDialog({ mode, exactDate, dateFrom, dateTo, onClose, onApply }: { mode: "exact" | "range"; exactDate: string; dateFrom: string; dateTo: string; onClose: () => void; onApply: (values: Pick<Filters, "exactDate" | "dateFrom" | "dateTo">) => void }) {
  const initial = isoToDate(mode === "exact" ? exactDate : dateFrom) || new Date();
  const [month, setMonth] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1, 12));
  const [selected, setSelected] = useState(exactDate);
  const [start, setStart] = useState(dateFrom);
  const [end, setEnd] = useState(dateTo);
  function pick(value: string) {
    if (mode === "exact") { setSelected(value); return; }
    if (!start || end) { setStart(value); setEnd(""); return; }
    if (value < start) { setStart(value); setEnd(start); return; }
    setEnd(value);
  }
  const ready = mode === "exact" ? Boolean(selected) : Boolean(start && end);
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3" onMouseDown={onClose}>
    <section className="w-full max-w-3xl overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
      <header className="flex items-center gap-3 border-b border-border-soft px-4 py-3">
        <div><p className="font-semibold">{mode === "exact" ? "选择日期" : "选择日期范围"}</p><p className="text-xs text-muted">{mode === "exact" ? (selected || "尚未选择") : (start && end ? start + " — " + end : start ? "已选择起点 " + start : "先选择起始日期")}</p></div>
        <div className="ml-auto flex gap-1"><button type="button" className="rounded-lg p-2 hover:bg-surface-2" onClick={() => setMonth((value) => monthOffset(value, -1))}><ChevronLeft className="size-4" /></button><button type="button" className="rounded-lg p-2 hover:bg-surface-2" onClick={() => setMonth((value) => monthOffset(value, 1))}><ChevronRight className="size-4" /></button></div>
      </header>
      <div className={cn("grid gap-8 p-5", mode === "range" && "md:grid-cols-2")}>
        <MonthCalendar month={month} selected={mode === "exact" ? selected : undefined} rangeStart={start} rangeEnd={end} onPick={pick} />
        {mode === "range" && <MonthCalendar month={monthOffset(month, 1)} rangeStart={start} rangeEnd={end} onPick={pick} />}
      </div>
      <footer className="flex justify-end gap-2 border-t border-border-soft p-3">
        <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
        <Button type="button" disabled={!ready} onClick={() => onApply(mode === "exact" ? { exactDate: selected, dateFrom: "", dateTo: "" } : { exactDate: "", dateFrom: start, dateTo: end })}>确认</Button>
      </footer>
    </section>
  </div>;
}

export function LocalGallery() {
  const [images, setImages] = useState<LocalImage[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState("");
  const loadEpoch = useRef(0);
  const detailNavigationBusy = useRef(false);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(() => { try { return typeof window === "undefined" ? EMPTY_FILTERS : { ...EMPTY_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) || "{}") }; } catch { return EMPTY_FILTERS; } });
  const [models, setModels] = useState<string[]>([]);
  const [samplers, setSamplers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [detail, setDetail] = useState<LocalImage | null>(null);
  const [hovered, setHovered] = useState<HoverPreview | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [favorites, setFavorites] = useState<number[]>(() => { try { return typeof window === "undefined" ? [] : JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"); } catch { return []; } });
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [collections, setCollections] = useState<Record<string, string[]>>(() => { try { return typeof window === "undefined" ? {} : JSON.parse(localStorage.getItem(COLLECTIONS_KEY) || "{}"); } catch { return {}; } });
  const [collection, setCollection] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [compare, setCompare] = useState<LocalImage[]>([]);
  const [privacyMode, setPrivacyMode] = useState(() => typeof window !== "undefined" && localStorage.getItem(PRIVACY_KEY) === "1");
  const [filterOpen, setFilterOpen] = useState(false);
  const [dateDialog, setDateDialog] = useState<"exact" | "range" | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [shortcuts, setShortcuts] = useState<LocalGalleryShortcuts>(() => loadLocalGalleryShortcuts());
  const restrictedIds = useMemo(() => {
    if (onlyFavorites) return favorites;
    if (collection) {
      return Object.entries(collections)
        .filter(([, names]) => names.includes(collection))
        .map(([id]) => Number(id))
        .filter(Number.isFinite);
    }
    return null;
  }, [collection, collections, favorites, onlyFavorites]);

  const load = useCallback(async (targetPage = 1, q = activeQuery, nextFilters = filters, nextRestrictedIds: number[] | null = restrictedIds) => {
    const epoch = ++loadEpoch.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(targetPage), q });
      if (nextRestrictedIds !== null) {
        params.set("restrict_ids", "1");
        params.set("ids", nextRestrictedIds.join(","));
      }
      const dateFrom = nextFilters.exactDate || nextFilters.dateFrom;
      const dateTo = nextFilters.exactDate || nextFilters.dateTo;
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      for (const key of ["model", "sampler", "orientation", "resolution"] as const) if (nextFilters[key]) params.set(key, nextFilters[key]);
      if (nextFilters.stepsFrom) params.set("steps_from", nextFilters.stepsFrom);
      if (nextFilters.stepsTo) params.set("steps_to", nextFilters.stepsTo);
      if (nextFilters.cfgFrom) params.set("cfg_from", nextFilters.cfgFrom);
      if (nextFilters.cfgTo) params.set("cfg_to", nextFilters.cfgTo);
      const cacheKey = params.toString();
      const cached = galleryPageCache.get(cacheKey);
      if (cached && Date.now() - cached.savedAt < GALLERY_CACHE_TTL) {
        const data = cached.value;
        setImages(data.images || []); setTotal(data.total || 0); setPageSize(Math.max(1, Number(data.page_size) || DEFAULT_PAGE_SIZE)); setPage(targetPage);
        setModels(data.models || []); setSamplers(data.samplers || []);
        setMessage(data.roots?.length ? `索引目录：${data.roots.join("；")}` : "请先在设置中添加画廊文件夹。");
        setLoading(false);
        return data.images || [];
      }
      const response = await fetch(`/api/local-gallery/images?${params}`);
      const data = await response.json() as GalleryResponse;
      if (epoch !== loadEpoch.current) return;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      galleryPageCache.set(cacheKey, { value: data, savedAt: Date.now() });
      setImages(data.images || []); setTotal(data.total || 0); setPageSize(Math.max(1, Number(data.page_size) || DEFAULT_PAGE_SIZE)); setPage(targetPage);
      setModels(data.models || []); setSamplers(data.samplers || []);
      setMessage(data.roots?.length ? `索引目录：${data.roots.join("；")}` : "请先在设置中添加画廊文件夹。");
      return data.images || [];
    } catch (error) { if (epoch === loadEpoch.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (epoch === loadEpoch.current) setLoading(false); }
  }, [activeQuery, filters, restrictedIds]);

  useEffect(() => { queueMicrotask(() => void load(1, "")); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); }, [filters]);
  useEffect(() => {
    const update = (event: Event) => setShortcuts((event as CustomEvent<LocalGalleryShortcuts>).detail || loadLocalGalleryShortcuts());
    window.addEventListener(LOCAL_GALLERY_SHORTCUTS_EVENT, update);
    return () => window.removeEventListener(LOCAL_GALLERY_SHORTCUTS_EVENT, update);
  }, []);

  async function scan() {
    galleryPageCache.clear();
    setMessage("正在增量扫描…");
    const response = await fetch("/api/local-gallery/scan", { method: "POST" }); const data = await response.json();
    setMessage(response.ok ? `扫描完成：新增 ${data.added}，更新 ${data.updated}，移动/重命名 ${data.moved || 0}，移除 ${data.removed}` : data.error);
    await load(1);
  }
  function submit(event: FormEvent) { event.preventDefault(); const value = query.trim(); setActiveQuery(value); void load(1, value, filters, restrictedIds); }
  function applyFilters(next = filters) { setFilters(next); void load(1, activeQuery, next, restrictedIds); }
  function toggleFavorite(id: number) {
    const adding = !favorites.includes(id);
    setFavorites((current) => {
      const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      if (onlyFavorites) queueMicrotask(() => void load(1, activeQuery, filters, next));
      return next;
    });
    toast.success(adding ? "已加入收藏" : "已取消收藏");
  }
  function updateCollection(image: LocalImage, value: string) { const names = value.split(/[，,]/).map((item) => item.trim()).filter(Boolean); setCollections((current) => { const next = { ...current, [String(image.id)]: names }; localStorage.setItem(COLLECTIONS_KEY, JSON.stringify(next)); return next; }); }
  function toggleCompare(image: LocalImage) { setCompare((current) => current.some((item) => item.id === image.id) ? current.filter((item) => item.id !== image.id) : current.length >= 2 ? [current[1], image] : [...current, image]); }
  function toggleSelected(id: number) { setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
  function applyPrompt(image: LocalImage) {
    if (!sendPromptToStudio(portableMetadata(image).positive_prompt || "")) toast.error("这张图片没有可返回的正向提示词。");
  }
  function applyParameters(image: LocalImage) { sendRecipeToStudio(recipeFromMetadata(portableMetadata(image), image.width, image.height)); }
  async function copyPrompt(image: LocalImage) {
    const metadata = portableMetadata(image);
    const text = [metadata.positive_prompt, metadata.negative_prompt ? `Negative prompt:\n${metadata.negative_prompt}` : ""].filter(Boolean).join("\n\n");
    if (!text) { toast.error("这张图片没有可复制的提示词。"); return; }
    try { await navigator.clipboard.writeText(text); }
    catch { toast.error("无法复制提示词，请在文本框中手动选择复制。"); }
  }
  function beginHover(image: LocalImage, element: HTMLElement) {
    if (privacyMode) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const rect = element.getBoundingClientRect();
    hoverTimer.current = setTimeout(() => {
      const width = Math.min(520, window.innerWidth * 0.42);
      const left = rect.right + 14 + width < window.innerWidth ? rect.right + 14 : Math.max(72, rect.left - width - 14);
      setHovered({ image, left, top: Math.max(16, Math.min(rect.top, window.innerHeight - 620)) });
    }, 220);
  }
  function endHover() { if (hoverTimer.current) clearTimeout(hoverTimer.current); hoverTimer.current = null; setHovered(null); }
  async function copyImage(image: LocalImage) {
    try {
      const blob = await fetch(mediaUrl(image)).then((response) => response.blob());
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      toast.success("已复制原始图片");
    } catch { toast.error("无法复制图像；视频或当前浏览器不支持该操作。"); }
  }
  async function deleteImage(image: LocalImage, askForConfirmation = true) {
    if (askForConfirmation && !confirm("把“" + image.name + "”移到回收站？")) return;
    const currentIndex = visible.findIndex((item) => item.id === image.id);
    const nextDetail = currentIndex >= 0
      ? (visible[currentIndex + 1] || visible[currentIndex - 1] || null)
      : null;
    const response = await fetch("/api/local-gallery/image/" + image.id, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) { toast.error(data.error || "删除失败"); return; }
    galleryPageCache.clear();
    setImages((current) => current.filter((item) => item.id !== image.id));
    setTotal((current) => Math.max(0, current - 1));
    setHovered(null);
    setDetail((current) => current?.id === image.id ? nextDetail : current);
    setFavorites((current) => {
      const next = current.filter((id) => id !== image.id);
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      return next;
    });
    setCollections((current) => {
      const next = { ...current };
      delete next[String(image.id)];
      localStorage.setItem(COLLECTIONS_KEY, JSON.stringify(next));
      return next;
    });
    toast.success("已移到 Windows 回收站");
    await load(page);
  }

  const collectionNames = useMemo(() => Array.from(new Set(Object.values(collections).flat())).sort(), [collections]);
  const visible = images.filter((image) => (!onlyFavorites || favorites.includes(image.id)) && (!collection || (collections[String(image.id)] || []).includes(collection)));
  const detailIndex = detail ? visible.findIndex((image) => image.id === detail.id) : -1;
  const navigateDetail = useCallback(async (delta: number) => {
    if (detailIndex < 0 || loading || detailNavigationBusy.current) return;
    const next = visible[detailIndex + delta];
    if (next) { setDetail(next); return; }
    const targetPage = page + (delta > 0 ? 1 : -1);
    if (targetPage < 1 || targetPage > Math.max(1, Math.ceil(total / pageSize))) return;
    const previousId = detail?.id;
    detailNavigationBusy.current = true;
    try {
      const items = await load(targetPage);
      const nextImage = delta > 0 ? items?.[0] : items?.at(-1);
      if (nextImage) setDetail((current) => current?.id === previousId ? nextImage : current);
    } finally { detailNavigationBusy.current = false; }
  }, [detailIndex, visible, loading, page, total, pageSize, detail?.id, load]);
  useEffect(() => {
    if (!detail) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      const action = (Object.keys(shortcuts) as LocalGalleryShortcutAction[])
        .find((key) => matchesShortcut(event, shortcuts[key]));
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat && action === "delete") return;
      switch (action) {
        case "previous": navigateDetail(-1); break;
        case "next": navigateDetail(1); break;
        case "close": setDetail(null); break;
        case "toggleFavorite": toggleFavorite(detail.id); break;
        case "delete": void deleteImage(detail, false); break;
        case "copyPrompt": void copyPrompt(detail); break;
        case "copyImage": if (detail.media_type === "image") void copyImage(detail); break;
        case "copyCleanImage": if (detail.media_type === "image") void copyImageWithoutMetadata(mediaUrl(detail)); break;
        case "usePrompt": applyPrompt(detail); break;
        case "useParameters": applyParameters(detail); break;
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [detail, navigateDetail, shortcuts]);  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const filterActive = Object.values(filters).some(Boolean);

  return <FeatureShell current="/local-gallery/" title="本地画廊" description={`缩略图缓存、每页 ${pageSize} 张、日期与生成参数筛选。`} hideHeader>
    <div className="grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
      <aside className="h-fit rounded-xl border border-border-soft bg-surface p-3 lg:sticky lg:top-4">
        <p className="mb-2 text-xs font-semibold text-muted">分类</p>
        <button className={cn("mb-1 flex w-full justify-between rounded-lg px-3 py-2 text-sm", !onlyFavorites && !collection ? "bg-accent/15 text-accent" : "hover:bg-surface-2")} onClick={() => { setOnlyFavorites(false); setCollection(""); void load(1, activeQuery, filters, null); }}>全部图片 <span>{!onlyFavorites && !collection ? total : "全部"}</span></button>
        <button className={cn("mb-1 flex w-full justify-between rounded-lg px-3 py-2 text-sm", onlyFavorites ? "bg-accent/15 text-accent" : "hover:bg-surface-2")} onClick={() => { setOnlyFavorites(true); setCollection(""); void load(1, activeQuery, filters, favorites); }}>收藏 <span>{favorites.length}</span></button>
        {collectionNames.map((name) => { const ids = Object.entries(collections).filter(([, values]) => values.includes(name)).map(([id]) => Number(id)).filter(Number.isFinite); return <button key={name} className={cn("flex w-full justify-between rounded-lg px-3 py-2 text-sm", collection === name && !onlyFavorites ? "bg-accent/15 text-accent" : "hover:bg-surface-2")} onClick={() => { setCollection(name); setOnlyFavorites(false); void load(1, activeQuery, filters, ids); }}>{name}<span>{ids.length}</span></button>; })}
      </aside>
      <section className="min-w-0">
        <form onSubmit={submit} className="mb-3 rounded-xl border border-border-soft bg-surface">
          <div className="flex flex-wrap items-center gap-2 p-3">
            <div className="mr-2 flex shrink-0 items-center gap-2 font-semibold">本地画廊 <span className="rounded bg-surface-3 px-2 py-0.5 text-xs text-muted">{total}</span></div>
            <div className="relative min-w-52 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="空格＝或，+词＝必须，-词＝排除" title={'例如 cat dog +blue -text：cat 或 dog，必须含 blue，排除 text；引号包住完整词组，如 "blue hair"。'} /></div>
            <Button type="button" variant={filters.dateFrom || filters.dateTo ? "default" : "outline"} onClick={() => setDateDialog("range")}><CalendarRange className="size-4" />日期过滤{filters.dateFrom && filters.dateTo ? " · " + filters.dateFrom.slice(5) + "—" + filters.dateTo.slice(5) : ""}</Button>
            <Button type="button" variant={filters.exactDate ? "default" : "outline"} onClick={() => setDateDialog("exact")}><CalendarDays className="size-4" />日期{filters.exactDate ? " · " + filters.exactDate.slice(5) : ""}</Button>
            <Button type="button" variant={filterOpen ? "default" : "outline"} onClick={() => setFilterOpen((value) => !value)}><SlidersHorizontal className="size-4" />筛选</Button>
            <Button type="button" variant={privacyMode ? "default" : "outline"} title="开启后缩略图全部打码，悬浮大图关闭；点击卡片仍可查看原图" onClick={() => setPrivacyMode((current) => { const next = !current; localStorage.setItem(PRIVACY_KEY, next ? "1" : "0"); endHover(); return next; })}>{privacyMode ? <EyeOff className="size-4" /> : <Eye className="size-4" />}隐私模式</Button>
            <Button type="button" variant={selectionMode ? "default" : "outline"} onClick={() => setSelectionMode((value) => { if (value) setSelected([]); return !value; })}><ListChecks className="size-4" />多选</Button>
            <a href="/settings/" className="inline-flex h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm"><FolderSearch className="size-4" />文件夹</a>
            <Button type="button" variant="outline" disabled={loading} onClick={() => void scan()}><RefreshCw className={cn("size-4", loading && "animate-spin")} />刷新</Button>
            <DesktopFullscreenButton />
          </div>
          {filterOpen && <div className="border-t border-border-soft p-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">
              <label className="grid gap-1 text-[11px] text-muted">模型<Select value={filters.model} onChange={(event) => setFilters((current) => ({ ...current, model: event.target.value }))}><option value="">全部模型</option>{models.map((value) => <option key={value} value={value}>{modelLabel(value)}</option>)}</Select></label>
              <label className="grid gap-1 text-[11px] text-muted">采样器<Select value={filters.sampler} onChange={(event) => setFilters((current) => ({ ...current, sampler: event.target.value }))}><option value="">全部采样器</option>{samplers.map((value) => <option key={value}>{value}</option>)}</Select></label>
              <label className="grid gap-1 text-[11px] text-muted">方向<Select value={filters.orientation} onChange={(event) => setFilters((current) => ({ ...current, orientation: event.target.value }))}><option value="">全部方向</option><option value="portrait">竖图</option><option value="landscape">横图</option><option value="square">方图</option></Select></label>
              <label className="grid gap-1 text-[11px] text-muted">分辨率<Input value={filters.resolution} onChange={(event) => setFilters((current) => ({ ...current, resolution: event.target.value }))} placeholder="例如 1024x1024" /></label>
              <label className="grid gap-1 text-[11px] text-muted">Steps 最小<Input type="number" min={1} value={filters.stepsFrom} onChange={(event) => setFilters((current) => ({ ...current, stepsFrom: event.target.value }))} /></label>
              <label className="grid gap-1 text-[11px] text-muted">Steps 最大<Input type="number" min={1} value={filters.stepsTo} onChange={(event) => setFilters((current) => ({ ...current, stepsTo: event.target.value }))} /></label>
              <label className="grid gap-1 text-[11px] text-muted">CFG 最小<Input type="number" min={0} step={0.1} value={filters.cfgFrom} onChange={(event) => setFilters((current) => ({ ...current, cfgFrom: event.target.value }))} /></label>
              <label className="grid gap-1 text-[11px] text-muted">CFG 最大<Input type="number" min={0} step={0.1} value={filters.cfgTo} onChange={(event) => setFilters((current) => ({ ...current, cfgTo: event.target.value }))} /></label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2"><Button type="button" size="sm" onClick={() => applyFilters()}>应用筛选</Button>{filterActive && <Button type="button" size="sm" variant="ghost" onClick={() => applyFilters(EMPTY_FILTERS)}>清除全部</Button>}</div>
          </div>}
        </form>
        <div className="mb-3 flex items-center gap-2 text-xs text-muted"><span className="truncate" title={message}>{message}</span><span className="ml-auto shrink-0">第 {page}/{pageCount} 页 · {total} 个</span></div>
        {compare.length === 2 && <div className="mb-4 grid gap-3 rounded-xl border border-accent/40 p-3 md:grid-cols-2">{compare.map((image) => <Media key={image.id} image={image} className="max-h-[60vh] w-full rounded-lg object-contain" />)}</div>}
        {!loading && images.length === 0 ? <div className="rounded-xl border border-dashed border-border p-12 text-center text-muted">没有符合条件的媒体。</div> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">{visible.map((image) => {
          const favorite = favorites.includes(image.id), checked = selected.includes(image.id), comparing = compare.some((item) => item.id === image.id);
          return <article key={image.id} className={cn("group overflow-hidden rounded-xl border bg-surface-2", checked || comparing ? "border-accent ring-1 ring-accent" : "border-border-soft")} onMouseEnter={(event) => beginHover(image, event.currentTarget)} onMouseLeave={endHover}>
            <button className="relative block aspect-[3/4] w-full overflow-hidden bg-surface-3" onClick={() => selectionMode ? toggleSelected(image.id) : setDetail(image)}>
              <Media image={image} thumbnail className={cn("size-full object-cover transition duration-300", privacyMode ? "scale-125 blur-[18px]" : "scale-[1.02] blur-[1.5px] group-hover:scale-105 group-hover:blur-0")} />
              {image.media_type === "video" && <span className="absolute right-2 top-2 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-bold text-white">VIDEO</span>}
            </button>
            <div className="p-2"><p className="truncate text-xs font-medium" title={image.name}>{image.name}</p><p className="mt-1 line-clamp-2 h-8 text-[10px] text-muted">{image.prompt || `${image.width} × ${image.height}`}</p><div className="mt-2 flex gap-0.5">
              <button title={favorite ? "取消收藏" : "收藏"} className={cn("rounded p-1.5", favorite ? "text-danger" : "text-muted")} onClick={() => toggleFavorite(image.id)}><Heart className={cn("size-3.5", favorite && "fill-current")} /></button>
              <button title="加入双图对比" className="rounded p-1.5 text-muted" onClick={() => toggleCompare(image)}><Columns3 className="size-3.5" /></button>
              {selectionMode && <button title="选择图片" className="rounded p-1.5 text-muted" onClick={() => toggleSelected(image.id)}><CheckSquare className="size-3.5" /></button>}
              {image.media_type === "image" && <button title="复制图像" className="rounded p-1.5 text-muted" onClick={() => void copyImage(image)}><Clipboard className="size-3.5" /></button>}
              <button title="移到回收站" className="rounded p-1.5 text-muted hover:text-danger" onClick={() => void deleteImage(image)}><Trash2 className="size-3.5" /></button>
              <button title="复用全部生成参数" className="ml-auto rounded p-1.5 text-accent" onClick={() => applyParameters(image)}><RotateCcw className="size-3.5" /></button>
            </div></div>
          </article>;
        })}</div>}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2"><Button variant="outline" disabled={loading || page <= 1} onClick={() => void load(page - 1, activeQuery, filters, restrictedIds)}><ChevronLeft className="size-4" />上一页</Button><span className="px-2 text-sm">{page} / {pageCount}</span><Button variant="outline" disabled={loading || page >= pageCount} onClick={() => void load(page + 1, activeQuery, filters, restrictedIds)}>下一页<ChevronRight className="size-4" /></Button>
          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); const target = Math.min(pageCount, Math.max(1, Math.floor(Number(jumpPage) || page))); void load(target); setJumpPage(""); }}><Input className="w-20" type="number" min={1} max={pageCount} value={jumpPage} onChange={(event) => setJumpPage(event.target.value)} placeholder={String(page)} aria-label="跳转页码" /><Button type="submit" variant="outline" disabled={loading}>跳转</Button></form>
        </div>
      </section>
    </div>
    {!privacyMode && hovered && !detail && (() => { const facts = imageFacts(hovered.image); return <div className="pointer-events-none fixed z-[70] hidden max-h-[82vh] overflow-hidden rounded-2xl border border-border bg-black/95 shadow-2xl xl:block" style={{ left: hovered.left, top: hovered.top, width: "min(520px,42vw)" }}><Media image={hovered.image} className="max-h-[66vh] w-full object-contain" /><div className="grid grid-cols-3 gap-1 p-2 text-[11px] text-white"><strong className="col-span-3 truncate">{hovered.image.name}</strong><span>{hovered.image.width}×{hovered.image.height}</span><span>{formatBytes(hovered.image.size)}</span><span>{new Date(hovered.image.modified_ns / 1e6).toLocaleDateString()}</span><span className="col-span-2 truncate" title={facts.model}>模型：{facts.model}</span><span>步数：{facts.steps}</span><span>种子：{facts.seed}</span><span className="col-span-2 truncate">采样器：{facts.sampler}</span></div></div>; })()}
    {dateDialog && <DateDialog mode={dateDialog} exactDate={filters.exactDate} dateFrom={filters.dateFrom} dateTo={filters.dateTo} onClose={() => setDateDialog(null)} onApply={(dates) => { const next = { ...filters, ...dates }; setDateDialog(null); applyFilters(next); }} />}
    {selected.length > 0 && <button className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-accent px-4 py-2 text-sm text-on-accent" onClick={() => void navigator.clipboard.writeText(images.filter((image) => selected.includes(image.id)).map((image) => image.path).join("\n"))}><Copy className="mr-2 inline size-4" />复制所选路径 · {selected.length}</button>}
    {detail && <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-hidden overscroll-contain bg-black/75 p-4" onClick={() => setDetail(null)}>
      <article className="grid max-h-[92vh] w-full max-w-6xl gap-4 overflow-auto overscroll-contain rounded-2xl border border-border bg-surface p-4 lg:grid-cols-[1.45fr_.55fr]" onClick={(event) => event.stopPropagation()}>
        <div className="relative flex min-h-64 items-center justify-center overflow-hidden rounded-xl bg-black/20">
          <Media image={detail} className="max-h-[84vh] w-full object-contain" />
          <button type="button" aria-label="上一张（支持跨页）" disabled={loading || detailIndex < 0 || (detailIndex === 0 && page <= 1)} onClick={() => void navigateDetail(-1)} className="absolute left-2 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white disabled:opacity-30"><ChevronLeft className="size-5" /></button>
          <button type="button" aria-label="下一张（支持跨页）" disabled={loading || detailIndex < 0 || (detailIndex >= visible.length - 1 && page >= pageCount)} onClick={() => void navigateDetail(1)} className="absolute right-2 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white disabled:opacity-30"><ChevronRight className="size-5" /></button>
          <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/80">{detailIndex + 1} / {visible.length}</span>
        </div>
        <div>
          <div className="flex gap-2"><h2 className="flex-1 break-all font-semibold">{detail.name}</h2><button onClick={() => setDetail(null)}><X className="size-5" /></button></div>
          <label className="mt-4 grid gap-1 text-xs text-muted">正向提示词<textarea readOnly value={portableMetadata(detail).positive_prompt || ""} placeholder="没有读取到正向提示词" className="min-h-32 resize-y select-text rounded-lg border border-border-soft bg-surface-2 p-2 text-fg" /></label>
          {portableMetadata(detail).negative_prompt && <label className="mt-3 grid gap-1 text-xs text-muted">负面提示词<textarea readOnly value={portableMetadata(detail).negative_prompt || ""} className="min-h-20 resize-y select-text rounded-lg border border-border-soft bg-surface-2 p-2 text-fg" /></label>}
          <label className="mt-4 grid gap-1 text-xs">集合<Input value={(collections[String(detail.id)] || []).join("，")} onChange={(event) => updateCollection(detail, event.target.value)} /></label>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => applyPrompt(detail)}><ImagePlus className="size-4" />仅提示词返回待用</Button>
            <Button variant="outline" onClick={() => applyParameters(detail)}><RotateCcw className="size-4" />提示词与参数返回</Button>
            <Button variant="outline" onClick={() => void copyPrompt(detail)}><Copy className="size-4" />复制提示词</Button>
            <Button variant="outline" className={cn(favorites.includes(detail.id) && "border-danger/50 bg-danger/10 text-danger hover:bg-danger/15 hover:text-danger")} onClick={() => toggleFavorite(detail.id)}><Heart className={cn("size-4", favorites.includes(detail.id) && "fill-current")} />{favorites.includes(detail.id) ? "已收藏" : "收藏"}</Button>
            {detail.media_type === "image" && <Button variant="outline" onClick={() => void copyImage(detail)}><Clipboard className="size-4" />复制原图</Button>}
            {detail.media_type === "image" && <Button variant="outline" onClick={() => void copyImageWithoutMetadata(mediaUrl(detail))}><Copy className="size-4" />复制无元数据图片</Button>}
            <Button variant="outline" onClick={() => void deleteImage(detail)}><Trash2 className="size-4" />移到 Windows 回收站</Button>
          </div>
          <p className="mt-3 text-[11px] text-muted">快捷键可在“设置 → 画廊快捷键”中修改；删除后会自动顺位到下一张。</p>
        </div>
      </article>
    </div>}
  </FeatureShell>;
}
