"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, Heart, ImageIcon, RotateCcw, Search, Shuffle, X } from "lucide-react";
import { toast } from "sonner";
import { FeatureShell } from "@/components/feature-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { recipeFromMetadata, sendRecipeToStudio, type PortableMetadata } from "@/lib/gallery-recipe";

type Item = {
  id: string; source: string; preview_url: string; file_url: string; tags: string;
  rating: string; score: number; title?: string; author?: string; prompt?: string; negative_prompt?: string;
  metadata?: PortableMetadata;
  media?: Array<{ url: string; prompt: string }>;
};

const FAVORITES_KEY = "dean-online-favorites-v1";
const BLACKLIST_KEY = "dean-online-blacklist-v1";
const RECENT_KEY = "dean-online-recent-v1";
const proxied = (url: string, thumb = true) => url ? `/api/online-gallery/v2/image?thumb=${thumb ? "1" : "0"}&url=${encodeURIComponent(url)}` : "";

function GalleryCard({ item: initial, favorite, onFavorite, onOpen }: {
  item: Item; favorite: boolean; onFavorite: () => void; onOpen: (item: Item) => void;
}) {
  const [item, setItem] = useState(initial);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (item.preview_url || item.source !== "aitag") return;
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      setLoading(true);
      const params = new URLSearchParams({ source: item.source, id: item.id });
      void fetch(`/api/online-gallery/v2/detail?${params}`)
        .then(async (response) => {
          const data = await response.json();
          if (response.ok) setItem((current) => ({ ...current, ...data }));
        })
        .finally(() => setLoading(false));
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [item.id, item.preview_url, item.source]);

  return (
    <article ref={ref} className="group overflow-hidden rounded-xl border border-border-soft bg-surface-2">
      <button type="button" onClick={() => item.preview_url && onOpen(item)} className="relative block aspect-square w-full overflow-hidden bg-surface-3">
        {item.preview_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={proxied(item.preview_url)} alt="" loading="lazy" className="size-full object-cover blur-[1px] transition duration-slow group-hover:scale-[1.04] group-hover:blur-0" />
        ) : <span className="flex size-full items-center justify-center text-muted"><ImageIcon className={cn("size-7", loading && "animate-pulse")} /></span>}
        <span className="absolute bottom-2 left-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] text-white">{item.source}</span>
      </button>
      <div className="p-2">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs font-medium">{item.title || `#${item.id}`}</p>
          <button type="button" className={favorite ? "text-danger" : "text-muted"} onClick={onFavorite} title={favorite ? "取消本地收藏" : "本地收藏"}><Heart className={cn("size-4", favorite && "fill-current")} /></button>
        </div>
        <p className="mt-1 line-clamp-2 h-8 text-[10px] leading-4 text-muted">{item.tags || item.author || "正在读取详情…"}</p>
        <div className="mt-2 flex gap-1.5">
          <button type="button" title="复制标签" className="rounded-md bg-surface-3 p-1.5 text-muted hover:text-fg" onClick={() => void navigator.clipboard.writeText(item.tags).then(() => toast.success("标签已复制"))}><Copy className="size-3.5" /></button>
          {item.file_url && <a href={item.file_url} target="_blank" rel="noreferrer" title="打开原图" className="rounded-md bg-surface-3 p-1.5 text-muted hover:text-fg"><ExternalLink className="size-3.5" /></a>}
          <span className="ml-auto text-[10px] text-muted">{item.score ? `score ${item.score}` : item.rating}</span>
        </div>
      </div>
    </article>
  );
}

export function OnlineGallery() {
  const [source, setSource] = useState("danbooru");
  const [mode, setMode] = useState<"search" | "popular">("search");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<Item | null>(null);
  const [favorites, setFavorites] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"); } catch { return []; }
  });
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [blacklist, setBlacklist] = useState(() => typeof window === "undefined" ? "" : localStorage.getItem(BLACKLIST_KEY) || "");
  const [hasMore, setHasMore] = useState(false);
  const [rating, setRating] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
  });
  const [period, setPeriod] = useState<"day" | "week" | "month">("week");
  const [rankingDate, setRankingDate] = useState("");

  async function load(nextPage = 1) {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ source, mode, q: query, page: String(nextPage), limit: "30", period });
      if (rankingDate) params.set("date", rankingDate);
      const response = await fetch(`/api/online-gallery/v2/search?${params}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setItems(data.items || []); setPage(nextPage); setHasMore(Boolean(data.has_more));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }

  function submit(event: FormEvent) { event.preventDefault(); void load(1); }
  function toggleFavorite(item: Item) {
    const key = `${item.source}:${item.id}`;
    setFavorites((current) => {
      const next = current.includes(key) ? current.filter((value) => value !== key) : [...current, key];
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); return next;
    });
  }
  const visible = useMemo(() => {
    const blocked = blacklist.toLowerCase().split(/[\s,]+/).filter(Boolean);
    return items.filter((item) => {
      const key = `${item.source}:${item.id}`;
      if (onlyFavorites && !favorites.includes(key)) return false;
      if (rating && item.rating !== rating) return false;
      const tags = item.tags.toLowerCase();
      return !blocked.some((word) => tags.split(/\s+/).includes(word));
    });
  }, [blacklist, favorites, items, onlyFavorites, rating]);

  function openDetail(item: Item) {
    setDetail(item);
    const key = `${item.source}:${item.id}`;
    setRecent((current) => {
      const next = [key, ...current.filter((value) => value !== key)].slice(0, 100);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }

  function applyPrompt(item: Item) {
    sendRecipeToStudio(recipeFromMetadata(item.metadata || {
      positive_prompt: item.prompt || item.tags,
      negative_prompt: item.negative_prompt || "",
    }));
  }

  function downloadSelected() {
    const chosen = items.filter((item) => selected.includes(`${item.source}:${item.id}`) && item.file_url);
    chosen.forEach((item, index) => setTimeout(() => {
      const anchor = document.createElement("a");
      anchor.href = item.file_url; anchor.target = "_blank"; anchor.download = `${item.source}-${item.id}`; anchor.click();
    }, index * 250));
    toast.success(`已提交 ${chosen.length} 个下载`);
  }

  return (
    <FeatureShell current="/online-gallery/" title="在线画廊" description="独立来源适配、分页、排行、渐进详情、本地收藏与黑名单。">
      <form onSubmit={submit} className="mb-4 grid gap-2 rounded-xl border border-border-soft bg-surface p-3 lg:grid-cols-[150px_145px_1fr_auto]">
        <Select value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="danbooru">Danbooru</option><option value="safebooru">Safebooru</option><option value="gelbooru">Gelbooru</option><option value="aitag">AI TAG</option>
        </Select>
        <Select value={mode} onChange={(event) => setMode(event.target.value === "popular" ? "popular" : "search")} disabled={source === "gelbooru"}>
          <option value="search">搜索/最新</option><option value="popular">热门排行</option>
        </Select>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标签、作者、标题或 Prompt" />
        <Button type="submit" disabled={loading}><Search className="size-4" />{loading ? "读取中" : "搜索"}</Button>
      </form>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border-soft bg-surface px-3 py-2">
        {mode === "popular" && source !== "gelbooru" && source !== "aitag" && <><Select className="max-w-32" value={period} onChange={(event) => setPeriod(event.target.value as typeof period)}><option value="day">日榜</option><option value="week">周榜</option><option value="month">月榜</option></Select><label className="flex items-center gap-2 rounded-lg border border-border px-2"><CalendarDays className="size-4 text-muted" /><input type="date" className="h-9 bg-transparent text-xs outline-none" value={rankingDate} onChange={(event) => setRankingDate(event.target.value)} /></label></>}
        <Input className="max-w-md" value={blacklist} onChange={(event) => { setBlacklist(event.target.value); localStorage.setItem(BLACKLIST_KEY, event.target.value); }} placeholder="本地黑名单标签，以空格分隔" />
        <Select className="max-w-36" value={rating} onChange={(event) => setRating(event.target.value)}><option value="">全部分级</option><option value="g">General</option><option value="s">Sensitive</option><option value="q">Questionable</option><option value="e">Explicit</option></Select>
        <Button variant={onlyFavorites ? "default" : "outline"} onClick={() => setOnlyFavorites((value) => !value)}><Heart className="size-4" />仅收藏</Button>
        <Button variant="outline" onClick={() => void load(Math.max(1, Math.floor(Math.random() * 200) + 1))}><Shuffle className="size-4" />随机浏览</Button>
        {selected.length > 0 && <Button variant="outline" onClick={downloadSelected}><Download className="size-4" />下载所选 · {selected.length}</Button>}
        <span className="ml-auto text-xs text-muted">第 {page} 页 · 显示 {visible.length} 项 · 最近查看 {recent.length}</span>
      </div>
      {error && <p className="mb-4 rounded-lg bg-danger-bg p-3 text-sm text-danger">{error}</p>}
      {!loading && items.length === 0 && !error ? <div className="rounded-xl border border-dashed border-border p-12 text-center text-muted">选择来源后开始搜索或查看排行。</div> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-7">
          {visible.map((item) => {
            const key = `${item.source}:${item.id}`;
            return <div key={key} className="relative">
              <GalleryCard item={item} favorite={favorites.includes(key)} onFavorite={() => toggleFavorite(item)} onOpen={openDetail} />
              <label className="absolute left-2 top-2 z-10 rounded-md bg-black/65 p-1 text-white"><input aria-label="选择下载" type="checkbox" checked={selected.includes(key)} onChange={() => setSelected((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key])} /></label>
            </div>;
          })}
        </div>
      )}
      <div className="mt-5 flex justify-center gap-2">
        <Button variant="outline" disabled={loading || page <= 1} onClick={() => void load(page - 1)}><ChevronLeft className="size-4" />上一页</Button>
        <Button variant="outline" disabled={loading || !hasMore} onClick={() => void load(page + 1)}>下一页<ChevronRight className="size-4" /></Button>
      </div>
      {detail && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onClick={() => setDetail(null)}>
        <article className="grid max-h-[90vh] w-full max-w-5xl gap-4 overflow-auto rounded-2xl border border-border bg-surface p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,.6fr)]" onClick={(event) => event.stopPropagation()}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <div className="grid gap-2"><img src={proxied(detail.preview_url, false)} alt="" className="max-h-[72vh] w-full rounded-xl object-contain" />{detail.media && detail.media.length > 1 && <div className="grid grid-cols-3 gap-2">{detail.media.slice(1).map((media) => <img key={media.url} src={proxied(media.url)} alt="" className="aspect-square w-full rounded-lg object-cover" />)}</div>}</div>
          <div><div className="flex items-start justify-between gap-3"><h2 className="font-semibold">{detail.title || `#${detail.id}`}</h2><button onClick={() => setDetail(null)}><X className="size-5" /></button></div>{detail.author && <button className="mt-2 text-xs text-accent" onClick={() => { setQuery(detail.author || ""); setDetail(null); }}>追踪作者：{detail.author}</button>}<p className="mt-4 whitespace-pre-wrap break-words text-xs leading-5">{detail.prompt || detail.tags}</p><div className="mt-4 flex flex-wrap gap-2"><Button onClick={() => applyPrompt(detail)}><RotateCcw className="size-4" />带提示词返回生图</Button><Button variant="outline" onClick={() => void navigator.clipboard.writeText(detail.prompt || detail.tags)}>复制 Prompt</Button><a href={detail.file_url} target="_blank" rel="noreferrer"><Button variant="outline">打开原图</Button></a></div></div>
        </article>
      </div>}
    </FeatureShell>
  );
}
