"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CloudDownload, Copy, Languages, Pin, RefreshCw, Search, Send, Tags } from "lucide-react";
import { toast } from "sonner";
import { FeatureShell } from "@/components/feature-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/lib/store";
import {
  browseLocalVocabulary,
  loadVocabularyOverview,
  rebuildLocalVocabulary,
  setLocalVocabularyTranslation,
  syncGlobalVocabulary,
  syncVocabularyScope,
  updateVocabularySyncSettings,
  setLocalVocabularyPin,
  type VocabularyCategory,
  type VocabularyStatus,
  type VocabularySyncStatus,
  type VocabularyTag,
} from "@/lib/vocabulary";

function appendTag(current: string, tag: string) {
  const clean = current.trim().replace(/,\s*$/, "");
  return clean ? `${clean}, ${tag}, ` : `${tag}, `;
}

const PAGE_SIZE = 60;
const CLICK_MODE_KEY = "dean-vocabulary-click-mode";
type ClickMode = "insert" | "copy";

export function VocabularyBrowser() {
  const settings = useStore((state) => state.settings);
  const patchSettings = useStore((state) => state.patchSettings);
  const [status, setStatus] = useState<VocabularyStatus | null>(null);
  const [categories, setCategories] = useState<VocabularyCategory[]>([]);
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<VocabularyTag[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState("");
  const [sync, setSync] = useState<VocabularySyncStatus | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncScope, setSyncScope] = useState("");
  const [syncMinPosts, setSyncMinPosts] = useState(1);
  const [syncMessage, setSyncMessage] = useState("");
  const [clickMode, setClickMode] = useState<ClickMode>(() => {
    if (typeof window === "undefined") return "insert";
    return window.localStorage.getItem(CLICK_MODE_KEY) === "copy" ? "copy" : "insert";
  });

  const refreshOverview = async (signal?: AbortSignal) => {
    const overview = await loadVocabularyOverview(signal);
    setStatus(overview.status);
    setCategories(overview.categories);
    setSync(overview.sync);
  };

  useEffect(() => {
    const controller = new AbortController();
    refreshOverview(controller.signal)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "\u8bfb\u53d6\u8bcd\u5e93\u5931\u8d25"))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => setPage(1), [query, category, pinnedOnly]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      if (!query.trim() && !category && !pinnedOnly) {
        setItems([]);
        setTotal(0);
        return;
      }
      setLoading(true);
      try {
        const result = await browseLocalVocabulary({
          query,
          category,
          pinnedOnly,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
          signal: controller.signal,
        });
        setItems(result.items);
        setTotal(result.total);
        setError("");
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "\u641c\u7d22\u8bcd\u5e93\u5931\u8d25");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, category, pinnedOnly, page]);

  const visibleCategories = useMemo(() => categories.slice(0, 24), [categories]);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const insert = (tag: string) => {
    patchSettings({ prompt: appendTag(String(settings.prompt || ""), tag) });
  };

  const changeClickMode = (mode: ClickMode) => {
    setClickMode(mode);
    window.localStorage.setItem(CLICK_MODE_KEY, mode);
  };

  const activateTag = async (tag: string) => {
    if (clickMode === "insert") {
      insert(tag);
      return;
    }
    try {
      await navigator.clipboard.writeText(`, ${tag}, `);
    } catch {
      setError("\u590d\u5236\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7cfb\u7edf\u526a\u8d34\u677f\u6743\u9650");
    }
  };

  const togglePin = async (item: VocabularyTag) => {
    try {
      await setLocalVocabularyPin(item.name, !item.pinned);
      const result = await browseLocalVocabulary({
        query, category, pinnedOnly, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "\u66f4\u65b0\u7f6e\u9876\u72b6\u6001\u5931\u8d25");
    }
  };

  const refreshCurrentResults = async () => {
    if (!query.trim() && !category && !pinnedOnly) return;
    const result = await browseLocalVocabulary({
      query, category, pinnedOnly, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
    });
    setItems(result.items);
    setTotal(result.total);
  };

  const runGlobalSync = async () => {
    setSyncBusy(true);
    setSyncMessage("");
    try {
      const result = await syncGlobalVocabulary();
      setSync(result.status);
      setStatus(result.vocabulary);
      await refreshOverview();
      await refreshCurrentResults();
      setSyncMessage(`\u5168\u5c40\u589e\u91cf\u5b8c\u6210\uff1a\u65b0\u589e ${result.result.inserted}\uff0c\u66f4\u65b0 ${result.result.updated}\uff0c\u8bfb\u53d6 ${result.result.received} \u6761`);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "\u540c\u6b65 Danbooru \u8bcd\u5e93\u5931\u8d25");
    } finally {
      setSyncBusy(false);
    }
  };

  const runScopeSync = async () => {
    if (!syncScope.trim()) {
      setError("\u8bf7\u8f93\u5165 Danbooru \u4f5c\u54c1\u6807\u7b7e\uff0c\u4f8b\u5982 wuthering_waves");
      return;
    }
    setSyncBusy(true);
    setSyncMessage("");
    try {
      const result = await syncVocabularyScope(syncScope, syncMinPosts, 4);
      setSync(result.status);
      setStatus(result.vocabulary);
      await refreshOverview();
      await refreshCurrentResults();
      setSyncMessage(`${syncScope} \u8865\u5168\u5b8c\u6210\uff1a\u65b0\u589e ${result.result.inserted}\uff0c\u66f4\u65b0 ${result.result.updated}\uff0c\u8bfb\u53d6 ${result.result.received} \u6761`);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "\u6307\u5b9a\u4f5c\u54c1\u540c\u6b65\u5931\u8d25");
    } finally {
      setSyncBusy(false);
    }
  };

  const changeSyncSettings = async (enabled: boolean, intervalHours: number) => {
    try {
      setSync(await updateVocabularySyncSettings(enabled, intervalHours));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "\u4fdd\u5b58\u540c\u6b65\u8bbe\u7f6e\u5931\u8d25");
    }
  };

  const editTranslation = async (item: VocabularyTag) => {
    const next = window.prompt(`\u4fee\u6539 ${item.name} \u7684\u4e2d\u6587\u7ffb\u8bd1\uff08\u6e05\u7a7a\u53ef\u5220\u9664\u7ffb\u8bd1\uff09`, item.translation);
    if (next === null) return;
    try {
      await setLocalVocabularyTranslation(item.name, next);
      setItems((current) => current.map((entry) => entry.name === item.name ? { ...entry, translation: next.trim() } : entry));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "\u4fdd\u5b58\u4e2d\u6587\u7ffb\u8bd1\u5931\u8d25");
    }
  };

  const rebuild = async () => {
    setRebuilding(true);
    try {
      setStatus(await rebuildLocalVocabulary());
      await refreshOverview();
      if (query.trim() || category || pinnedOnly) {
        const result = await browseLocalVocabulary({
          query, category, pinnedOnly, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
        });
        setItems(result.items);
        setTotal(result.total);
      }
      toast.success("\u8bcd\u5e93\u7d22\u5f15\u5df2\u66f4\u65b0");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "\u66f4\u65b0\u8bcd\u5e93\u5931\u8d25");
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <FeatureShell current="vocabulary" title={"\u6807\u7b7e\u8bcd\u5e93"} description={"\u641c\u7d22\u548c\u67e5\u9605\u672c\u5730\u6807\u7b7e\uff0c\u5e76\u63d2\u5165\u5230\u751f\u56fe\u63d0\u793a\u8bcd\u3002"}>
      <div className="rounded-[var(--radius-card)] border border-border-soft bg-surface p-4 shadow-[var(--shadow-panel)]">
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-[18rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder={"\u641c\u7d22\u82f1\u6587\u6807\u7b7e\u6216\u4e2d\u6587\u91ca\u4e49"} autoFocus />
          </label>
          <Button variant="outline" onClick={() => void rebuild()} disabled={rebuilding}>
            <RefreshCw className={rebuilding ? "size-4 animate-spin" : "size-4"} />
            {"\u66f4\u65b0\u7d22\u5f15"}
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => setCategory("")} className={`rounded-full border px-3 py-1 text-xs ${category === "" ? "border-accent bg-accent/15 text-accent" : "border-border-soft text-muted hover:text-fg"}`}>{"\u5168\u90e8"}</button>
          <button
            type="button"
            onClick={() => setPinnedOnly((value) => !value)}
            className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs ${pinnedOnly ? "border-accent bg-accent/15 text-accent" : "border-border-soft text-muted hover:text-fg"}`}
          >
            <Pin className="size-3" />
            {"\u7f6e\u9876"}
          </button>
          {visibleCategories.map((item) => (
            <button key={item.category} type="button" onClick={() => setCategory(item.category)} className={`rounded-full border px-3 py-1 text-xs ${category === item.category ? "border-accent bg-accent/15 text-accent" : "border-border-soft text-muted hover:text-fg"}`}>
              {item.category} {" - "} {item.count.toLocaleString()}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <div className="flex items-center gap-2">
            <Tags className="size-3.5" />
            {status?.ready ? `${status.tag_count.toLocaleString()} \u4e2a\u6807\u7b7e \u00b7 ${status.source_count} \u4e2a\u6765\u6e90` : status?.available ? "\u8bcd\u5e93\u7b49\u5f85\u5efa\u7acb\u7d22\u5f15" : "\u672a\u627e\u5230 tags \u8bcd\u5e93"}
          </div>
          <div className="inline-flex rounded-lg border border-border-soft bg-surface-2 p-1">
            <button type="button" onClick={() => changeClickMode("insert")} className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 ${clickMode === "insert" ? "bg-accent/15 text-accent" : "hover:text-fg"}`}>
              <Send className="size-3" />{"\u52a0\u5165\u5f85\u7528"}
            </button>
            <button type="button" onClick={() => changeClickMode("copy")} className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 ${clickMode === "copy" ? "bg-accent/15 text-accent" : "hover:text-fg"}`}>
              <Copy className="size-3" />{"\u590d\u5236\u6807\u7b7e"}
            </button>
          </div>
        </div>
        <div className="mt-4 border-t border-border-soft pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-fg">{"Danbooru \u5728\u7ebf\u589e\u91cf\u540c\u6b65"}</p>
              <p className="mt-1 text-xs text-muted">
                {sync?.last_sync_at ? `\u4e0a\u6b21\uff1a${new Date(sync.last_sync_at).toLocaleString()} \u00b7 \u5728\u7ebf\u6807\u7b7e ${sync.remote_tag_count.toLocaleString()}` : "\u5c1a\u672a\u540c\u6b65"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-fg-2">
                <input
                  type="checkbox"
                  checked={sync?.enabled ?? true}
                  onChange={(event) => void changeSyncSettings(event.target.checked, sync?.interval_hours || 24)}
                  className="accent-[var(--accent)]"
                />
                {"\u81ea\u52a8\u540c\u6b65"}
              </label>
              <label className="flex items-center gap-2 text-xs text-fg-2">
                <span>{"\u95f4\u9694"}</span>
                <Input
                  type="number"
                  min={1}
                  max={168}
                  value={sync?.interval_hours || 24}
                  onChange={(event) => void changeSyncSettings(sync?.enabled ?? true, Number(event.target.value) || 24)}
                  className="h-8 w-20"
                />
                <span>{"\u5c0f\u65f6"}</span>
              </label>
              <Button variant="outline" size="sm" disabled={syncBusy} onClick={() => void runGlobalSync()}>
                <CloudDownload className={syncBusy ? "size-4 animate-pulse" : "size-4"} />
                {"\u7acb\u5373\u589e\u91cf"}
              </Button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_8rem_auto]">
            <Input value={syncScope} onChange={(event) => setSyncScope(event.target.value)} placeholder={"\u4f5c\u54c1\u6807\u7b7e\uff0c\u4f8b\u5982 wuthering_waves"} />
            <Input type="number" min={0} value={syncMinPosts} onChange={(event) => setSyncMinPosts(Math.max(0, Number(event.target.value) || 0))} title={"\u6700\u4f4e Danbooru \u4f7f\u7528\u91cf"} />
            <Button variant="outline" disabled={syncBusy || !syncScope.trim()} onClick={() => void runScopeSync()}>
              {"\u8865\u5168\u4f5c\u54c1\u89d2\u8272"}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            {"\u6570\u5b57\u4e3a\u6700\u4f4e\u4f7f\u7528\u91cf\uff1b0 \u4f1a\u5305\u542b\u51e0\u4e4e\u6ca1\u6709\u6295\u7a3f\u7684\u751f\u50fb\u6807\u7b7e\u3002\u4eba\u5de5\u4e2d\u6587\u7ffb\u8bd1\u4e0d\u4f1a\u88ab\u540c\u6b65\u8986\u76d6\u3002"}
          </p>
          {syncMessage && <p className="mt-2 text-xs text-accent">{syncMessage}</p>}
          {sync?.last_error && <p className="mt-2 text-xs text-danger">{sync.last_error}</p>}
        </div>
      </div>

      {error && <p className="mt-4 rounded-[var(--radius-card)] border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>}

      <div className="mt-5 flex flex-wrap gap-2">
        {items.map((item) => (
          <div key={item.name} className={`inline-flex overflow-hidden rounded-full border ${item.pinned ? "border-accent/70 bg-accent/10" : "border-cat-general/45 bg-cat-general/10"}`}>
            <button
              type="button"
              title={clickMode === "copy" ? "\u590d\u5236\u4e3a\uff1a, tag, " : "\u52a0\u5165\u5f85\u7528\u63d0\u793a\u8bcd"}
              onClick={() => void activateTag(item.name)}
              className="px-3 py-1.5 text-xs text-cat-general transition-colors hover:bg-cat-general/20"
            >
              <span className="font-[family-name:var(--font-mono)]">{item.name}</span>
              {item.translation && <span className="text-fg-2">{"\uff08"}{item.translation}{"\uff09"}</span>}
              {item.hot >= 0 && <span className="text-muted">{" - "}{item.hot.toLocaleString()}</span>}
            </button>
            <button type="button" title={"\u4fee\u6539\u4e2d\u6587\u7ffb\u8bd1"} aria-label={"\u4fee\u6539\u4e2d\u6587\u7ffb\u8bd1"} onClick={() => void editTranslation(item)} className="border-l border-cat-general/25 px-2 text-muted transition-colors hover:bg-accent/15 hover:text-accent">
              <Languages className="size-3" />
            </button>
            <button type="button" title={item.pinned ? "\u53d6\u6d88\u7f6e\u9876" : "\u7f6e\u9876\u6807\u7b7e"} aria-label={item.pinned ? "\u53d6\u6d88\u7f6e\u9876" : "\u7f6e\u9876\u6807\u7b7e"} onClick={() => void togglePin(item)} className={`border-l px-2 transition-colors hover:bg-accent/15 ${item.pinned ? "border-accent/30 text-accent" : "border-cat-general/25 text-muted hover:text-accent"}`}>
              <Pin className={`size-3 ${item.pinned ? "fill-current" : ""}`} />
            </button>
          </div>
        ))}
      </div>

      {!loading && !items.length && (
        <div className="mt-16 text-center text-sm text-muted">{query.trim() || category || pinnedOnly ? "\u6ca1\u6709\u627e\u5230\u5339\u914d\u6807\u7b7e" : "\u8f93\u5165\u5173\u952e\u8bcd\u5f00\u59cb\u641c\u7d22"}</div>
      )}
      {loading && <div className="mt-16 text-center text-sm text-muted">{"\u6b63\u5728\u641c\u7d22\u8bcd\u5e93\u2026"}</div>}
      {!loading && total > PAGE_SIZE && (
        <div className="mt-8 flex items-center justify-center gap-4">
          <Button variant="outline" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            <ChevronLeft className="size-4" />{"\u4e0a\u4e00\u9875"}
          </Button>
          <span className="min-w-28 text-center text-sm text-muted">
            {page} / {pageCount}{" \u00b7 "}{total.toLocaleString()} {"\u6761"}
          </span>
          <Button variant="outline" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>
            {"\u4e0b\u4e00\u9875"}<ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </FeatureShell>
  );
}
