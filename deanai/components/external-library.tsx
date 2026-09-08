"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BookPlus, ChevronDown, ChevronLeft, ChevronRight, Copy, Database, Folder, Heart, ImageDown, Pin, Play, Plus, RefreshCw, Search, Square, Trash2, UsersRound, X } from "lucide-react";
import { FeatureShell } from "@/components/feature-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/lib/store";
import { toast } from "sonner";
import { cancelExternalJob, createCustomExternalSource, deleteCustomExternalSource, externalCharacterPrompts, externalFullPrompt, loadExternalCategories, loadExternalEntries, loadExternalJob, loadExternalSources, saveExternalToLocal, startExternalCache, startExternalSync, updateExternalUserData, type ExternalEntry, type ExternalJob, type ExternalSource } from "@/lib/external-library";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 60;
const SOURCE_KEY = "dean-external-library-source";
const IS_STATIC_PWA = process.env.NEXT_PUBLIC_STATIC_PWA === "1";

function appendPrompt(current: string, incoming: string) {
  const left = current.trim().replace(/,\s*$/, "");
  const right = incoming.trim().replace(/^,\s*/, "");
  return left && right ? `${left}, ${right}` : left || right;
}

type DirectoryNode = { name: string; path: string; count: number; children: DirectoryNode[] };
type MutableDirectoryNode = DirectoryNode & { childMap: Map<string, MutableDirectoryNode> };

function buildDirectoryTree(rows: Array<{ category: string; count: number; parts?: string[] }>): DirectoryNode[] {
  const roots = new Map<string, MutableDirectoryNode>();
  for (const row of rows) {
    const parts = (row.parts?.length ? row.parts : row.category.split("/")).map((part) => part.trim()).filter(Boolean);
    let current = roots;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let node = current.get(part);
      if (!node) {
        node = { name: part, path, count: 0, children: [], childMap: new Map() };
        current.set(part, node);
      }
      node.count += row.count;
      current = node.childMap;
    }
  }
  const finish = (nodes: Map<string, MutableDirectoryNode>): DirectoryNode[] =>
    [...nodes.values()]
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN"))
      .map((node) => ({ name: node.name, path: node.path, count: node.count, children: finish(node.childMap) }));
  return finish(roots);
}

function DirectoryRows({ nodes, depth, selected, expanded, onSelect, onToggle }: {
  nodes: DirectoryNode[]; depth: number; selected: string; expanded: Set<string>;
  onSelect: (path: string) => void; onToggle: (path: string) => void;
}) {
  return <>{nodes.map((node) => {
    const open = expanded.has(node.path);
    const hasChildren = node.children.length > 0;
    return <div key={node.path}>
      <div className={cn("group flex items-center rounded-lg text-sm", selected === node.path ? "bg-accent/12 text-accent" : "text-fg-2 hover:bg-surface-3")} style={{ paddingLeft: `${6 + depth * 14}px` }}>
        <button type="button" className="flex size-7 shrink-0 items-center justify-center text-muted" onClick={() => hasChildren && onToggle(node.path)} aria-label={open ? "\u6536\u8d77" : "\u5c55\u5f00"}>
          {hasChildren ? (open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />) : <span className="size-3.5" />}
        </button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left" onClick={() => onSelect(node.path)}>
          <span className="truncate">{node.name}</span><span className="ml-auto shrink-0 text-[11px] text-muted">{node.count.toLocaleString()}</span>
        </button>
      </div>
      {hasChildren && open && <DirectoryRows nodes={node.children} depth={depth + 1} selected={selected} expanded={expanded} onSelect={onSelect} onToggle={onToggle} />}
    </div>;
  })}</>;
}

function EntryCard({ entry, open, favorite, pin, use, copy, saveLocal, hover, leave }: {
  entry: ExternalEntry; open: () => void; favorite: () => void; pin: () => void;
  use: () => void; copy: () => void; saveLocal: () => void;
  hover: (element: HTMLElement) => void; leave: () => void;
}) {
  const image = entry.images[0];
  const cached = Boolean(image?.cached_bytes);
  return <article className="group overflow-hidden rounded-2xl border border-border-soft bg-surface-2">
    <button type="button" onClick={open} onMouseEnter={(event) => hover(event.currentTarget)} onMouseLeave={leave} className="relative block aspect-[4/3] w-full overflow-hidden bg-surface-3">
      {image ? <img src={image.thumbnail_url} alt="" loading="lazy" className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" /> : <span className="flex size-full flex-col items-center justify-center gap-2 text-muted"><Database className="size-8" /><span className="text-xs">{"\u65e0\u793a\u4f8b\u56fe"}</span></span>}
      {image && !cached && <span className="absolute right-2 top-2 rounded-md bg-amber-500/90 px-2 py-1 text-[10px] font-semibold text-black">{"\u672a\u7f13\u5b58"}</span>}
      {!image && <span className="absolute right-2 top-2 rounded-md bg-black/70 px-2 py-1 text-[10px] text-white">{"\u6765\u6e90\u672a\u63d0\u4f9b\u914d\u56fe"}</span>}
      <span className="absolute bottom-2 left-2 rounded-md bg-black/65 px-2 py-1 text-[10px] text-white">{entry.source_title}</span>
    </button>
    <div className="p-3"><button type="button" onClick={open} className="line-clamp-1 w-full text-left text-sm font-semibold">{entry.title || entry.external_id}</button>
      <p className="mt-1 line-clamp-2 h-9 text-xs leading-[18px] text-muted">{entry.prompt}</p>
      {externalCharacterPrompts(entry).length > 0 && <p className="mt-1 text-[10px] font-medium text-accent"><UsersRound className="mr-1 inline size-3" />{externalCharacterPrompts(entry).length} 个角色提示词</p>}
      <div className="mt-3 flex items-center justify-between gap-1"><span className="line-clamp-1 min-w-0 flex-1 text-[11px] text-muted">{entry.category || "\u672a\u5206\u7c7b"}</span><span className="flex shrink-0">
        <button type="button" title={"\u4f7f\u7528\u5230\u573a\u666f\u63d0\u793a\u8bcd"} onClick={use} className="rounded p-1.5 hover:bg-surface-3 hover:text-accent"><Play className="size-3.5" /></button>
        <button type="button" title={"\u590d\u5236\u63d0\u793a\u8bcd"} onClick={copy} className="rounded p-1.5 hover:bg-surface-3 hover:text-accent"><Copy className="size-3.5" /></button>
        {!IS_STATIC_PWA && <button type="button" title={entry.saved_entry_id ? "\u66f4\u65b0\u672c\u5730\u8d44\u6599" : "\u52a0\u5165\u672c\u5730\u8d44\u6599\u5e93\uff08\u542b\u793a\u4f8b\u7f29\u7565\u56fe\uff09"} onClick={saveLocal} className={cn("rounded p-1.5 hover:bg-surface-3 hover:text-accent", entry.saved_entry_id && "text-accent")}><BookPlus className="size-3.5" /></button>}
        <button type="button" title={"\u7f6e\u9876"} onClick={pin} className={cn("rounded p-1.5", entry.pinned && "text-accent")}><Pin className="size-3.5" /></button>
        <button type="button" title={entry.favorite ? "取消收藏" : "收藏"} onClick={favorite} className={cn("rounded p-1.5", entry.favorite ? "text-danger" : "text-muted")}><Heart className={cn("size-3.5", entry.favorite && "fill-current")} /></button>
      </span></div>
    </div>
  </article>;
}

export function ExternalLibrary() {
  const settings = useStore((state) => state.settings);
  const patchSettings = useStore((state) => state.patchSettings);
  const [sources, setSources] = useState<ExternalSource[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<Array<{ category: string; count: number; parts?: string[] }>>([]);
  const [favorites, setFavorites] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [entries, setEntries] = useState<ExternalEntry[]>([]);
  const [selected, setSelected] = useState<ExternalEntry | null>(null);
  const [hovered, setHovered] = useState<{ entry: ExternalEntry; left: number; top: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const [note, setNote] = useState("");
  const [imageIndex, setImageIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [job, setJob] = useState<ExternalJob | null>(null);
  const [sourceManagerOpen, setSourceManagerOpen] = useState(false);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [sourceAuthorized, setSourceAuthorized] = useState(false);
  const [sourceForm, setSourceForm] = useState({
    title: "", catalog_url: "", source_url: "", author: "", format: "auto",
    entries_path: "", asset_base_url: "", field_map: "",
  });
  const roots = useMemo(() => sources.filter((x) => !x.parent_id), [sources]);
  const selectableSources = useMemo(() => sources.filter((source) => !source.is_collection), [sources]);
  const selectedSource = useMemo(() => selectableSources.find((source) => source.id === sourceId) || null, [selectableSources, sourceId]);
  const directoryTree = useMemo(() => buildDirectoryTree(categories), [categories]);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const refreshSources = async () => {
    const next = (await loadExternalSources()).sources;
    setSources(next);
    const leaves = next.filter((source) => !source.is_collection);
    setSourceId((current) => {
      if (leaves.some((source) => source.id === current)) return current;
      const stored = window.localStorage.getItem(SOURCE_KEY) || "";
      return leaves.some((source) => source.id === stored) ? stored : ([...leaves].sort((left, right) => right.entry_count - left.entry_count)[0]?.id || "all");
    });
  };
  const refreshEntries = async () => {
    const result = await loadExternalEntries({ source: sourceId, search: query, category, favorites, pinned, page, pageSize: PAGE_SIZE });
    setEntries(result.entries); setTotal(result.total);
  };

  useEffect(() => { refreshSources().catch((x) => setError(String(x))); }, []);
  useEffect(() => {
    setPage(1); setCategory("");
    setExpandedDirectories(new Set());
    if (!sourceId) return;
    const controller = new AbortController();
    loadExternalCategories(sourceId, controller.signal).then((x) => setCategories(x.categories)).catch(() => undefined);
    return () => controller.abort();
  }, [sourceId]);
  useEffect(() => {
    setExpandedDirectories(new Set(directoryTree.map((node) => node.path)));
  }, [directoryTree]);
  useEffect(() => setPage(1), [query, category, favorites, pinned]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => loadExternalEntries({ source: sourceId, search: query, category, favorites, pinned, page, pageSize: PAGE_SIZE, signal: controller.signal })
      .then((x) => { setEntries(x.entries); setTotal(x.total); setError(""); })
      .catch((x) => { if (!controller.signal.aborted) setError(String(x)); }), 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [sourceId, query, category, favorites, pinned, page]);
  useEffect(() => {
    if (!job || ["complete", "failed", "cancelled"].includes(job.status)) return;
    const timer = window.setInterval(() => loadExternalJob(job.id).then(async (next) => {
      setJob(next);
      if (["complete", "failed", "cancelled"].includes(next.status)) await Promise.all([refreshSources(), refreshEntries()]);
    }).catch(() => undefined), 1000);
    return () => window.clearInterval(timer);
  }, [job]);
  useEffect(() => () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
  }, []);
  useEffect(() => {
    if (!selected) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [selected]);

  const beginSync = async (target: string) => {
    const result = await startExternalSync(target, false);
    setJob({ id: result.job_id, status: "queued", phase: "queued", current: 0, total: 0 });
  };
  const beginCache = async (target: string) => {
    const result = await startExternalCache(target);
    setJob({ id: result.job_id, status: "queued", phase: "queued", current: 0, total: 0 });
  };
  const mutate = async (entry: ExternalEntry, patch: { favorite?: boolean; pinned?: boolean; personal_note?: string }) => {
    const value = await updateExternalUserData(entry, patch);
    const update = (item: ExternalEntry) => item.source_id === entry.source_id && item.external_id === entry.external_id ? { ...item, ...value } : item;
    setEntries((items) => items.map(update));
    setSelected((item) => item ? update(item) : item);
  };
  const chooseSource = (next: string) => {
    setSourceId(next);
    window.localStorage.setItem(SOURCE_KEY, next);
  };
  const toggleDirectory = (path: string) => setExpandedDirectories((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const applyEntry = (entry: ExternalEntry, mode: "scene" | "characters" = "scene", negative = false) => {
    const characters = externalCharacterPrompts(entry);
    patchSettings({
      scenePrompt: mode === "scene" ? externalFullPrompt(entry) : entry.prompt.trim(),
      scenePromptName: entry.title || "外置资料",
      ...(mode === "characters" ? {
        characters: characters.map((item) => ({
          prompt: item.prompt, uc: item.negative_prompt,
          center: { x: 0.5, y: 0.5 }, enabled: true,
        })),
      } : {}),
      ...(negative && entry.negative_prompt ? { negativePrompt: appendPrompt(String(settings.negativePrompt || ""), entry.negative_prompt) } : {}),
    });
    toast.success(mode === "characters" ? "已拆分 " + characters.length + " 个角色提示词" : "完整提示词已放入场景");
  };
  const copyEntry = async (entry: ExternalEntry) => {
    await navigator.clipboard.writeText(externalFullPrompt(entry));
    toast.success("已复制主提示词和全部角色词");
  };  const saveLocal = async (entry: ExternalEntry) => {
    let result: { entry_id: number };
    try {
      result = await saveExternalToLocal(entry);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    const update = (item: ExternalEntry) => item.source_id === entry.source_id && item.external_id === entry.external_id
      ? { ...item, saved_entry_id: result.entry_id } : item;
    setEntries((items) => items.map(update));
    setSelected((item) => item ? update(item) : item);
  };
  const showHover = (entry: ExternalEntry, element: HTMLElement) => {
    if (!entry.images[0]) return;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    const rect = element.getBoundingClientRect();
    const width = Math.min(520, window.innerWidth * 0.42);
    const left = rect.right + 14 + width < window.innerWidth
      ? rect.right + 14 : Math.max(86, rect.left - width - 14);
    const top = Math.max(16, Math.min(rect.top, window.innerHeight - Math.min(720, window.innerHeight * 0.82) - 16));
    hoverTimer.current = window.setTimeout(() => setHovered({ entry, left, top }), 220);
  };
  const hideHover = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHovered(null);
  };
  const missingThumbnailCount = roots.reduce((sum, source) => sum + Math.max(0, source.image_count - source.cached_count), 0);
  const addCustomSource = async () => {
    setSourceSaving(true); setError("");
    try {
      const fieldMap = sourceForm.field_map.trim() ? JSON.parse(sourceForm.field_map) : undefined;
      const created = await createCustomExternalSource({ ...sourceForm, field_map: fieldMap, terms_confirmed: true });
      await refreshSources(); chooseSource(created.id);
      setSourceForm({ title: "", catalog_url: "", source_url: "", author: "", format: "auto", entries_path: "", asset_base_url: "", field_map: "" });
      setSourceAuthorized(false);
      setSourceManagerOpen(false); await beginSync(created.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSourceSaving(false); }
  };
  const removeCustomSource = async () => {
    if (!selectedSource || selectedSource.provider !== "generic" || !window.confirm("删除外置来源“" + selectedSource.title + "”？本地资料库中已保存的卡片不会删除。")) return;
    try {
      await deleteCustomExternalSource(selectedSource.id);
      setSourceId(""); await refreshSources(); setSourceManagerOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <FeatureShell current="external-library" title="外置资料库" description="程序不附带任何外置内容或默认来源；仅处理用户自行配置并有权使用的结构化数据。">
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border-soft bg-surface p-3 shadow-[var(--shadow-card)]">
        <label className="relative min-w-[260px] flex-1 sm:max-w-[420px]">
          <Database className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-accent" />
          <select value={sourceId} onChange={(event) => chooseSource(event.target.value)} className="h-11 w-full appearance-none rounded-xl border border-border-soft bg-surface-2 pl-10 pr-10 text-sm font-semibold text-fg outline-none focus:border-accent">
            {!selectableSources.length && <option value="">尚未配置来源</option>}
            {selectableSources.map((source) => <option key={source.id} value={source.id}>{source.title} - {source.entry_count}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        </label>
        <div className="relative min-w-[260px] flex-[2]"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><Input className="h-11 pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={"\u641c\u7d22\u5f53\u524d\u8d44\u6599\u5e93\u7684\u6807\u9898\u3001\u63d0\u793a\u8bcd\u6216 tag"} /></div>
        <Button variant={favorites ? "default" : "outline"} onClick={() => setFavorites((value) => !value)}><Heart className="mr-2 size-4" />{"\u6536\u85cf"}</Button>
        <Button variant={pinned ? "default" : "outline"} onClick={() => setPinned((value) => !value)}><Pin className="mr-2 size-4" />{"\u7f6e\u9876"}</Button>
        {!IS_STATIC_PWA && <Button variant="outline" disabled={!selectableSources.length} title="仅更新用户已配置来源的标题、提示词和分类，不下载图片" onClick={() => beginSync("all")}><RefreshCw className="mr-2 size-4" />更新全部索引</Button>}
        {!IS_STATIC_PWA && <Button variant="outline" title={"\u53ea\u4e0b\u8f7d\u5c1a\u672a\u7f13\u5b58\u7684\u538b\u7f29 WebP \u7f29\u7565\u56fe\uff0c\u4e0d\u91cd\u590d\u4e0b\u8f7d\u5df2\u6709\u6587\u4ef6"} disabled={missingThumbnailCount <= 0} onClick={() => beginCache("all")}><ImageDown className="mr-2 size-4" />{"\u7f13\u5b58\u672a\u7f13\u5b58\u56fe\u7247"}{missingThumbnailCount > 0 && <>{" ("}{missingThumbnailCount.toLocaleString()}{")"}</>}</Button>}
        {!IS_STATIC_PWA && <Button variant="outline" onClick={() => setSourceManagerOpen((value) => !value)}><Plus className="mr-2 size-4" />添加来源</Button>}
      </div>
      {!IS_STATIC_PWA && sourceManagerOpen && <section className="rounded-2xl border border-accent/30 bg-surface p-4 shadow-[var(--shadow-card)]">
        <div className="flex items-start justify-between gap-4"><div><h2 className="font-semibold">添加结构化外置来源</h2><p className="mt-1 text-xs leading-relaxed text-muted">程序不提供、不推荐也不代为获取第三方内容或来源地址。仅支持用户自行填写的 JSON、JSONL、CSV；不会绕过登录、加密、付费墙或访问限制。</p></div>{selectedSource?.provider === "generic" && <Button variant="outline" size="sm" onClick={() => void removeCustomSource()}><Trash2 className="mr-1 size-3.5" />删除当前来源</Button>}</div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-xs text-muted">显示名称<Input className="mt-1" value={sourceForm.title} onChange={(event) => setSourceForm((value) => ({ ...value, title: event.target.value }))} placeholder="例如：我的服装词库" /></label>
          <label className="text-xs text-muted md:col-span-2">目录数据地址<Input className="mt-1" value={sourceForm.catalog_url} onChange={(event) => setSourceForm((value) => ({ ...value, catalog_url: event.target.value }))} placeholder="https://example.com/catalog.json" /></label>
          <label className="text-xs text-muted">格式<select className="mt-1 h-11 w-full rounded-xl border border-border-soft bg-surface-2 px-3 text-sm" value={sourceForm.format} onChange={(event) => setSourceForm((value) => ({ ...value, format: event.target.value }))}><option value="auto">自动识别</option><option value="json">JSON</option><option value="jsonl">JSONL</option><option value="csv">CSV</option></select></label>
          <label className="text-xs text-muted">来源网页（可选）<Input className="mt-1" value={sourceForm.source_url} onChange={(event) => setSourceForm((value) => ({ ...value, source_url: event.target.value }))} /></label>
          <label className="text-xs text-muted">作者（可选）<Input className="mt-1" value={sourceForm.author} onChange={(event) => setSourceForm((value) => ({ ...value, author: event.target.value }))} /></label>
          <label className="text-xs text-muted">条目数组路径（可选）<Input className="mt-1" value={sourceForm.entries_path} onChange={(event) => setSourceForm((value) => ({ ...value, entries_path: event.target.value }))} placeholder="data.entries" /></label>
          <label className="text-xs text-muted">图片基础地址（可选）<Input className="mt-1" value={sourceForm.asset_base_url} onChange={(event) => setSourceForm((value) => ({ ...value, asset_base_url: event.target.value }))} /></label>
        </div>
        <details className="mt-3 rounded-xl bg-surface-2 p-3"><summary className="cursor-pointer text-xs font-semibold">高级字段映射</summary><textarea className="mt-3 min-h-24 w-full rounded-xl border border-border-soft bg-surface p-3 font-mono text-xs" value={sourceForm.field_map} onChange={(event) => setSourceForm((value) => ({ ...value, field_map: event.target.value }))} placeholder={'{"title":"name","prompt":"nai.tags","category":"path","images":"previews"}'} /><p className="mt-2 text-[11px] text-muted">值使用点路径。普通 HTML、登录或加密网站仍需对方提供 JSON/CSV 导出或专用适配器。</p></details>
        <label className="mt-3 flex items-start gap-2 rounded-xl border border-border-soft p-3 text-xs leading-relaxed text-muted"><input type="checkbox" className="mt-0.5" checked={sourceAuthorized} onChange={(event) => setSourceAuthorized(event.target.checked)} /><span>我确认自己有权访问和使用该来源，并会遵守来源许可、服务条款及适用法律。来源内容与行为由我自行负责。</span></label>
        <div className="mt-3 flex justify-end gap-2"><Button variant="outline" onClick={() => setSourceManagerOpen(false)}>取消</Button><Button disabled={sourceSaving || !sourceAuthorized || !sourceForm.title.trim() || !sourceForm.catalog_url.trim()} onClick={() => void addCustomSource()}>{sourceSaving ? "正在添加…" : "添加并建立索引"}</Button></div>
      </section>}      {job && <div className="rounded-2xl border border-border-soft bg-surface p-3"><div className="flex items-center gap-3">
          <RefreshCw className={cn("size-4 text-accent", !["complete", "failed", "cancelled"].includes(job.status) && "animate-spin")} />
          <div className="flex-1"><div className="flex justify-between text-xs"><span>{job.message || job.phase}</span><span>{job.current} / {job.total || "?"}</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-surface-4"><div className="h-full bg-accent" style={{ width: job.total ? `${job.current / job.total * 100}%` : "5%" }} /></div></div>
          {!["complete", "failed", "cancelled"].includes(job.status) && <Button variant="outline" size="sm" onClick={() => cancelExternalJob(job.id)}><Square className="size-3.5" /></Button>}
        </div>{job.error && <p className="mt-2 text-xs text-red-400">{job.error}</p>}</div>}
      <div className="grid items-start gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="overflow-hidden rounded-2xl border border-border-soft bg-surface xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)]">
          <div className="border-b border-border-soft p-4">
            <div className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent"><Database className="size-5" /></span><div className="min-w-0"><h2 className="line-clamp-2 text-sm font-bold">{selectedSource?.title || "\u9009\u62e9\u8d44\u6599\u5e93"}</h2><p className="mt-1 text-[11px] text-muted">{selectedSource?.author} {selectedSource?.version && `\u00b7 ${selectedSource.version}`}</p></div></div>
            {selectedSource && <><div className="mt-3 flex justify-between text-[11px] text-muted"><span>{selectedSource.entry_count.toLocaleString()}{" \u6761\u8d44\u6599"}</span><span>{selectedSource.cached_count.toLocaleString()} / {selectedSource.image_count.toLocaleString()}{" \u5df2\u7f13\u5b58\u7f29\u7565\u56fe"}</span></div><div className="mt-1.5 h-1.5 overflow-hidden rounded bg-surface-3"><div className="h-full bg-accent" style={{ width: selectedSource.image_count ? `${Math.min(100, selectedSource.cached_count / selectedSource.image_count * 100)}%` : "0%" }} /></div></>}
          </div>
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3"><span className="flex items-center gap-2 text-xs font-semibold text-muted"><Folder className="size-4" />{"\u76ee\u5f55"}</span>{!IS_STATIC_PWA && <span className="flex gap-2"><button type="button" className="text-[11px] text-accent hover:underline" onClick={() => beginSync(sourceId)}>{"\u66f4\u65b0\u7d22\u5f15"}</button><button type="button" className="text-[11px] text-accent hover:underline" onClick={() => beginCache(sourceId)}>{"\u7f13\u5b58\u5f53\u524d\u7f3a\u56fe"}</button></span>}</div>
          <div className="max-h-[calc(100vh-250px)] overflow-y-auto px-2 pb-3">
            <button type="button" onClick={() => setCategory("")} className={cn("mb-1 flex w-full items-center rounded-lg px-3 py-2 text-left text-sm", !category ? "bg-accent/12 text-accent" : "text-fg-2 hover:bg-surface-3")}><Folder className="mr-2 size-4" /><span>{"\u5168\u90e8"}</span><span className="ml-auto text-[11px] text-muted">{selectedSource?.entry_count.toLocaleString() || 0}</span></button>
            <DirectoryRows nodes={directoryTree} depth={0} selected={category} expanded={expandedDirectories} onSelect={setCategory} onToggle={toggleDirectory} />
          </div>
        </aside>
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border-soft bg-surface px-3 py-2 text-xs text-muted"><span>{selectedSource?.title}</span><ChevronRight className="size-3.5" /><span className="font-semibold text-fg">{category || "\u5168\u90e8\u76ee\u5f55"}</span><span className="ml-auto">{total.toLocaleString()}{" \u6761"}</span></div>
        {error && <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
        {entries.length ? <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{entries.map((entry) => <EntryCard key={entry.source_id + entry.external_id} entry={entry}
          open={() => { hideHover(); setSelected(entry); setNote(entry.personal_note); setImageIndex(0); }}
          favorite={() => mutate(entry, { favorite: !entry.favorite })}
          pin={() => mutate(entry, { pinned: !entry.pinned })}
          use={() => applyEntry(entry)}
          copy={() => copyEntry(entry)}
          saveLocal={() => void saveLocal(entry)}
          hover={(element) => showHover(entry, element)}
          leave={hideHover}
        />)}</div>
          : <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-border-soft text-muted"><Database className="mb-3 size-10" /><p>{sources.some((x) => x.entry_count) ? "\u6ca1\u6709\u5339\u914d\u6761\u76ee" : "\u70b9\u51fb\u201c\u540c\u6b65\u5168\u90e8\u8d44\u6599\u201d\u5efa\u7acb\u672c\u5730\u7d22\u5f15"}</p></div>}
        <div className="flex items-center justify-center gap-4 py-3"><Button variant="outline" disabled={page <= 1} onClick={() => setPage((x) => x - 1)}><ChevronLeft className="mr-1 size-4" />{"\u4e0a\u4e00\u9875"}</Button><span className="text-sm text-muted">{page} / {pages}{" \u00b7 "}{total.toLocaleString()}{" \u6761"}</span><Button variant="outline" disabled={page >= pages} onClick={() => setPage((x) => x + 1)}>{"\u4e0b\u4e00\u9875"}<ChevronRight className="ml-1 size-4" /></Button></div>
        </section>
      </div>
    </div>
    {hovered && !selected && <div className="pointer-events-none fixed z-[70] hidden max-h-[82vh] overflow-hidden rounded-2xl border border-border bg-black/95 shadow-2xl xl:block" style={{ left: hovered.left, top: hovered.top, width: "min(520px,42vw)" }}>
      <img src={hovered.entry.images[0].thumbnail_url} alt="" className="max-h-[66vh] w-full object-contain" />
      <div className="p-3 text-white"><strong className="block truncate text-sm">{hovered.entry.title}</strong>
        <p className="mt-1 line-clamp-3 text-[11px] leading-5 text-white/70">{hovered.entry.prompt}</p>
      </div>
    </div>}
    {selected && <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-hidden overscroll-contain bg-black/70 p-2 sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
      <div className="grid max-h-[94dvh] w-full max-w-5xl overflow-y-auto overscroll-contain rounded-2xl border border-border-soft bg-surface shadow-2xl lg:grid-cols-[minmax(0,1.15fr)_minmax(340px,.85fr)] lg:overflow-hidden">
        <div className="flex min-h-72 flex-col items-center justify-center gap-3 bg-black/30 p-3">{selected.images[imageIndex] ? <img src={selected.images[imageIndex].thumbnail_url} alt="" className="min-h-0 max-h-[42dvh] max-w-full flex-1 object-contain lg:max-h-[72vh]" /> : <Database className="size-12 text-muted" />}
          {selected.images.length > 1 && <div className="flex max-w-full gap-2 overflow-x-auto">{selected.images.map((image, index) => <button type="button" key={image.image_index} onClick={() => setImageIndex(index)} className={cn("size-14 shrink-0 overflow-hidden rounded-lg border-2", imageIndex === index ? "border-accent" : "border-transparent")}><img src={image.thumbnail_url} alt="" loading="lazy" className="size-full object-cover" /></button>)}</div>}
          {selected.images.length > 1 && <span className="text-xs text-white/70">{imageIndex + 1} / {selected.images.length}</span>}
        </div>
        <div className="min-w-0 overflow-visible p-4 sm:p-5 lg:overflow-y-auto"><div className="flex justify-between gap-3"><div><a href={selected.source_url} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">{selected.source_title}{" \u00b7 \u67e5\u770b\u6765\u6e90"}</a><h2 className="mt-1 text-xl font-bold">{selected.title}</h2><p className="mt-1 text-xs text-muted">{selected.category}</p></div><button onClick={() => setSelected(null)}><X className="size-5" /></button></div>
          <h3 className="mt-5 text-xs font-semibold text-muted">{"\u6b63\u9762\u63d0\u793a\u8bcd"}</h3><p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-xl bg-surface-2 p-3 text-sm leading-6 select-text">{selected.prompt}</p>
          {externalCharacterPrompts(selected).length > 0 && <div className="mt-4 space-y-3">
            <h3 className="text-xs font-semibold text-muted">角色提示词 · {externalCharacterPrompts(selected).length}</h3>
            {externalCharacterPrompts(selected).map((character, index) => <div key={index} className="rounded-xl border border-accent/25 bg-accent/5 p-3">
              <p className="mb-1 text-xs font-semibold text-accent">{character.label || ("char" + (index + 1))}</p>
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-6 select-text">{character.prompt}</p>
              {character.negative_prompt && <p className="mt-2 border-t border-border-soft pt-2 text-xs text-muted">负面：{character.negative_prompt}</p>}
            </div>)}
          </div>}
          {selected.negative_prompt && <><h3 className="mt-4 text-xs font-semibold text-muted">{"\u8d1f\u9762\u63d0\u793a\u8bcd"}</h3><p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-xl bg-surface-2 p-3 text-sm leading-6 select-text">{selected.negative_prompt}</p></>}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => mutate(selected, { personal_note: note })} placeholder={"\u4e2a\u4eba\u5907\u6ce8\uff08\u4ec5\u672c\u673a\uff09"} className="mt-4 min-h-20 w-full rounded-xl border border-border-soft bg-surface-2 p-3 text-sm outline-none focus:border-accent" />
          <div className="mt-4 grid grid-cols-2 gap-2"><Button onClick={() => applyEntry(selected, "scene")}><Play className="mr-2 size-4" />全部到场景</Button><Button variant="outline" onClick={() => applyEntry(selected, "characters")} disabled={!externalCharacterPrompts(selected).length}><UsersRound className="mr-2 size-4" />拆分到角色</Button>
            <Button variant="outline" onClick={() => applyEntry(selected, "scene", true)} disabled={!selected.negative_prompt}>含负面词使用</Button><Button variant="outline" onClick={() => void copyEntry(selected)}><Copy className="mr-2 size-4" />复制完整提示词</Button>{!IS_STATIC_PWA && <Button variant="outline" onClick={() => void saveLocal(selected)}><BookPlus className="mr-2 size-4" />{selected.saved_entry_id ? "更新本地资料" : "加入本地资料库"}</Button>}</div>
        </div>
      </div>
    </div>}
  </FeatureShell>;
}
