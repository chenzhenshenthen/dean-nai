"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Database, FolderTree, ImageIcon, Play, Search, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  externalCharacterPrompts,
  externalFullPrompt,
  loadExternalCategories,
  loadExternalEntries,
  loadExternalSources,
  type ExternalEntry,
  type ExternalSource,
} from "@/lib/external-library";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 30;
const SOURCE_KEY = "dean-external-library-source";

type CategoryItem = { category: string; count: number; parts?: string[] };

function categoryLabel(path: string) {
  return path.split("/").filter(Boolean).at(-1) || path;
}

export function ExternalLibraryPicker({ onUse }: {
  onUse: (entry: ExternalEntry, includeNegative: boolean, mode?: "scene" | "characters") => void;
}) {
  const [sources, setSources] = useState<ExternalSource[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [entries, setEntries] = useState<ExternalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const selectable = useMemo(() => sources.filter((source) => !source.is_collection), [sources]);
  const selectedSource = selectable.find((source) => source.id === sourceId);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const treeCategories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of categories) {
      const parts = item.category.split("/").filter(Boolean);
      if (!parts.length) continue;
      parts.forEach((_, index) => {
        const path = parts.slice(0, index + 1).join("/");
        counts.set(path, (counts.get(path) || 0) + item.count);
      });
    }
    return [...counts].map(([path, count]) => ({ path, count }))
      .sort((left, right) => left.path.localeCompare(right.path, "zh-CN", { numeric: true }));
  }, [categories]);

  const categoryParents = useMemo(() => {
    const values = new Set<string>();
    for (const item of treeCategories) {
      const parts = item.path.split("/");
      for (let depth = 1; depth < parts.length; depth += 1) values.add(parts.slice(0, depth).join("/"));
    }
    return values;
  }, [treeCategories]);

  const visibleCategories = useMemo(() => treeCategories.filter((item) => {
    const parts = item.path.split("/");
    return !parts.slice(0, -1).some((_, index) => collapsed.includes(parts.slice(0, index + 1).join("/")));
  }), [collapsed, treeCategories]);

  useEffect(() => {
    const controller = new AbortController();
    loadExternalSources(controller.signal).then((result) => {
      setSources(result.sources);
      const available = result.sources.filter((source) => !source.is_collection);
      const saved = window.localStorage.getItem(SOURCE_KEY) || "";
      const next = available.some((source) => source.id === saved)
        ? saved
        : [...available].sort((left, right) => right.entry_count - left.entry_count)[0]?.id || "";
      setSourceId(next);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setCategory("");
    setCollapsed([]);
    setPage(1);
    if (!sourceId) return;
    window.localStorage.setItem(SOURCE_KEY, sourceId);
    const controller = new AbortController();
    loadExternalCategories(sourceId, controller.signal)
      .then((result) => setCategories(result.categories))
      .catch(() => setCategories([]));
    return () => controller.abort();
  }, [sourceId]);

  useEffect(() => setPage(1), [query, category]);

  useEffect(() => {
    if (!sourceId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      loadExternalEntries({
        source: sourceId, search: query, category, page, pageSize: PAGE_SIZE,
        signal: controller.signal,
      }).then((result) => {
        setEntries(result.entries);
        setTotal(result.total);
        setError("");
      }).catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, 160);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [category, page, query, sourceId]);

  const categoryButton = (active: boolean) => cn(
    "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors",
    active ? "bg-accent/15 font-semibold text-accent" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
  );

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="grid shrink-0 gap-2 border-b border-border-soft pb-3 sm:grid-cols-[minmax(180px,320px)_minmax(0,1fr)]">
      <Select value={sourceId} onChange={(event) => setSourceId(event.target.value)} aria-label="外置资料源">
        {selectable.map((source) => <option key={source.id} value={source.id}>{source.title} - {source.entry_count}</option>)}
      </Select>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="搜索标题、提示词或 tag" />
      </div>
      <Select value={category} onChange={(event) => setCategory(event.target.value)} className="sm:col-span-2 md:hidden" aria-label="外置资料分类">
        <option value="">全部分类 - {selectedSource?.entry_count || 0}</option>
        {treeCategories.map((item) => <option key={item.path} value={item.path}>{item.path} - {item.count}</option>)}
      </Select>
    </div>

    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-border-soft py-3 pr-2 md:block lg:w-64">
        <p className="mb-2 flex items-center gap-2 px-2.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
          <FolderTree className="size-3.5" /> 分类目录
        </p>
        <button type="button" className={categoryButton(!category)} onClick={() => setCategory("")}>
          <span>全部分类</span>
          <span className="text-[10px] tabular-nums text-muted">{selectedSource?.entry_count || 0}</span>
        </button>
        {visibleCategories.map((item) => {
          const depth = Math.max(0, item.path.split("/").filter(Boolean).length - 1);
          const hasChildren = categoryParents.has(item.path);
          const expanded = !collapsed.includes(item.path);
          return <button
            type="button"
            key={item.path}
            className={categoryButton(category === item.path)}
            style={{ paddingLeft: 10 + depth * 12 }}
            onClick={() => setCategory(item.path)}
            title={item.path}
          >
            <span className="flex min-w-0 items-center">
              {hasChildren ? <span
                role="button"
                tabIndex={0}
                className="mr-1 grid size-5 shrink-0 place-items-center rounded text-muted hover:bg-surface-3 hover:text-fg"
                aria-label={expanded ? "折叠子分类" : "展开子分类"}
                aria-expanded={expanded}
                onClick={(event) => {
                  event.stopPropagation();
                  setCollapsed((current) => current.includes(item.path)
                    ? current.filter((path) => path !== item.path)
                    : [...current, item.path]);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  setCollapsed((current) => current.includes(item.path)
                    ? current.filter((path) => path !== item.path)
                    : [...current, item.path]);
                }}
              >{expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</span>
                : <span className="mr-1 size-5 shrink-0" />}
              <span className="truncate">{categoryLabel(item.path)}</span>
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted">{item.count}</span>
          </button>;
        })}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto py-3 md:pl-3">
          {error ? <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>
            : loading && !entries.length ? <p className="py-12 text-center text-sm text-muted">正在读取外置资料…</p>
            : !entries.length ? <p className="py-12 text-center text-sm text-muted">没有匹配的外置资料。</p>
            : <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">{entries.map((entry) => {
              const image = entry.images[0];
              const cached = Boolean(image?.cached_bytes);
              return <article key={entry.source_id + entry.external_id} className="flex min-w-0 gap-3 rounded-xl border border-border-soft bg-surface-2 p-2.5">
                <div className="relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-3 text-muted">
                  {image ? <img src={image.thumbnail_url} alt="" loading="lazy" className="size-full object-cover" /> : <span className="flex flex-col items-center gap-1"><ImageIcon className="size-5" /><span className="text-[10px]">无示例图</span></span>}
                  {image && !cached && <span className="absolute right-1 top-1 rounded bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-semibold text-black">未缓存</span>}
                  {!image && <span className="absolute inset-x-1 bottom-1 rounded bg-black/65 px-1 py-0.5 text-center text-[8px] text-white">来源未配图</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold" title={entry.title}>{entry.title}</h3>
                  <p className="truncate text-[10px] text-muted">{entry.category || entry.source_title}</p>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-fg-2" title={entry.prompt}>{entry.prompt}</p>
                  {externalCharacterPrompts(entry).length > 0 && <p className="mt-1 text-[10px] text-accent">{externalCharacterPrompts(entry).length} 个角色提示词</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button size="sm" className="h-7 px-2 text-[11px]" disabled={!entry.prompt} onClick={() => onUse(entry, false, "scene")}><Play className="size-3" />全部到场景</Button>
                    {externalCharacterPrompts(entry).length > 0 && <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => onUse(entry, false, "characters")}><UsersRound className="size-3" />拆分角色</Button>}
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void navigator.clipboard.writeText(externalFullPrompt(entry)).then(() => toast.success("完整提示词已复制"), () => toast.error("复制失败"))}><Copy className="size-3" />复制完整</Button>
                    {entry.negative_prompt && <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => onUse(entry, true)}>含负面词</Button>}
                  </div>
                </div>
              </article>;
            })}</div>}
        </main>
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-border-soft py-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button>
          <span className="text-xs text-muted">{page} / {pages} · {total.toLocaleString()} 条</span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</Button>
        </div>
      </div>
    </div>
  </div>;
}
