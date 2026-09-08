"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Database, Download, FileUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { importMobileLibraryPayload } from "@/lib/db/mobile-library";
import { importMobileExternalLibrary } from "@/lib/db/mobile-external-library";
import { loadExternalSources, type ExternalSource } from "@/lib/external-library";

type ExportChoice = "local-full" | "external-full" | "all-full" | "local-incremental" | "external-incremental";
type DesktopSyncApi = {
  save_export?: (endpoint: string) => Promise<{ ok?: boolean; cancelled?: boolean; filename?: string; bytes?: number; error?: string }>;
};
type ExportJob = {
  id: string;
  status: "queued" | "running" | "complete" | "failed";
  phase: string;
  processed: number;
  total: number | null;
  filename?: string | null;
  bytes?: number | null;
  local_count?: number;
  external_count?: number;
  source_count?: number;
  error?: string;
};
type ProgressState = {
  phase: string;
  current: number;
  total: number;
  complete?: boolean;
};

const IS_STATIC_PWA = process.env.NEXT_PUBLIC_STATIC_PWA === "1";
const OPTIONS: Array<{ value: ExportChoice; label: string }> = [
  { value: "local-full", label: "本地资料库 · 全部" },
  { value: "external-full", label: "外置资料库 · 全部" },
  { value: "all-full", label: "本地 + 外置 · 全部" },
  { value: "local-incremental", label: "本地资料库 · 增量" },
  { value: "external-incremental", label: "外置资料库 · 增量" },
];

function bridge(): DesktopSyncApi | undefined {
  return (window as typeof window & { pywebview?: { api?: DesktopSyncApi } }).pywebview?.api;
}

function formatBytes(value?: number | null) {
  if (!value) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export function MobileLibrarySync() {
  const [choice, setChoice] = useState<ExportChoice>("all-full");
  const [baseline, setBaseline] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<ExternalSource[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [sourceError, setSourceError] = useState("");
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [lastJob, setLastJob] = useState<ExportJob | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const baselineInput = useRef<HTMLInputElement>(null);
  const incremental = choice.endsWith("incremental");
  const [scope, mode] = choice.split("-") as ["local" | "external" | "all", "full" | "incremental"];
  const includesExternal = scope === "external" || scope === "all";
  const leafSources = useMemo(() => sources.filter((source) => !source.is_collection), [sources]);

  useEffect(() => {
    if (IS_STATIC_PWA) return;
    const controller = new AbortController();
    void loadExternalSources(controller.signal).then(({ sources: loaded }) => {
      setSources(loaded);
      setSelectedSources(loaded.filter((source) => !source.is_collection).map((source) => source.id));
      setSourceError("");
    }).catch((error) => {
      if (!controller.signal.aborted) setSourceError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ phase?: string; current?: number; total?: number }>).detail || {};
      const labels: Record<string, string> = {
        connecting: "正在连接本地导出文件",
        saving: "正在保存到磁盘",
        complete: "保存完成",
        cancelled: "已取消保存",
        failed: "保存失败",
      };
      setProgress({
        phase: labels[detail.phase || ""] || "正在保存",
        current: Number(detail.current || 0),
        total: Number(detail.total || 0),
        complete: detail.phase === "complete",
      });
    };
    window.addEventListener("deanai-export-save-progress", listener);
    return () => window.removeEventListener("deanai-export-save-progress", listener);
  }, []);

  function leafIdsUnder(sourceId: string) {
    const found = new Set<string>();
    const visit = (parentId: string) => {
      for (const source of sources) {
        if (source.id === parentId && !source.is_collection) found.add(source.id);
        if (source.parent_id === parentId) visit(source.id);
      }
    };
    visit(sourceId);
    return [...found];
  }

  function toggleSource(source: ExternalSource, checked: boolean) {
    const ids = source.is_collection ? leafIdsUnder(source.id) : [source.id];
    setSelectedSources((current) => {
      const next = new Set(current);
      for (const id of ids) checked ? next.add(id) : next.delete(id);
      return [...next];
    });
  }

  async function importPackage(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as { entries?: unknown[]; external_sources?: unknown[]; external_entries?: unknown[] };
      let localCount = 0;
      if (Array.isArray(payload.entries) && payload.entries.length) {
        localCount = await importMobileLibraryPayload(payload);
      }
      const externalCount = await importMobileExternalLibrary(payload);
      if (!localCount && !externalCount) {
        if (Array.isArray(payload.entries) || Array.isArray(payload.external_entries)) {
          toast.info("资料已是最新，没有需要合并的条目");
          return;
        }
        throw new Error("资料包中没有可导入的本地或外置资料");
      }
      toast.success(`增量导入完成：本地 ${localCount} 条，外置 ${externalCount} 条`);
      window.dispatchEvent(new CustomEvent("deanai-mobile-library-updated"));
    } catch (error) {
      toast.error(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      if (importInput.current) importInput.current.value = "";
    }
  }

  async function waitForExport(jobId: string) {
    for (;;) {
      const job = await responseJson<ExportJob>(await fetch(`/api/export/mobile/jobs/${jobId}`));
      setLastJob(job);
      setProgress({ phase: job.phase, current: job.processed || 0, total: job.total || 0 });
      if (job.status === "failed") throw new Error(job.error || "导出失败");
      if (job.status === "complete") return job;
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
  }

  async function exportPackage() {
    if (includesExternal && selectedSources.length === 0) {
      toast.error("请至少选择一个外置资料库");
      return;
    }
    setBusy(true);
    setLastJob(null);
    setProgress({ phase: "正在创建导出任务", current: 0, total: 0 });
    try {
      let manifest: Record<string, string> = {};
      if (incremental) {
        if (!baseline) throw new Error("请先选择上一次导出的便携资料包作为比较基线");
        const parsed = JSON.parse(await baseline.text()) as { manifest?: Record<string, string> };
        if (!parsed.manifest || typeof parsed.manifest !== "object") {
          throw new Error("这个文件没有增量清单，请先导出一次新版完整资料包");
        }
        manifest = parsed.manifest;
      }
      const started = await responseJson<ExportJob>(await fetch("/api/export/mobile/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope,
          mode,
          source_ids: includesExternal ? selectedSources : undefined,
          manifest,
        }),
      }));
      const completed = await waitForExport(started.id);
      const endpoint = `/api/export/mobile/jobs/${completed.id}/download`;
      const api = bridge();
      if (api?.save_export) {
        setProgress({ phase: "等待选择保存位置", current: 0, total: completed.bytes || 0 });
        const saved = await api.save_export(endpoint);
        if (saved.cancelled) return;
        if (!saved.ok) throw new Error(saved.error || "保存失败");
        toast.success(`已保存：${saved.filename}`);
      } else {
        const anchor = document.createElement("a");
        anchor.href = endpoint;
        anchor.download = completed.filename || "deanai便携资料.json";
        anchor.click();
        setProgress({ phase: "资料包已生成，浏览器已开始下载", current: 1, total: 1, complete: true });
        toast.success("资料包已生成，浏览器已开始下载");
      }
    } catch (error) {
      setProgress({ phase: `导出失败：${error instanceof Error ? error.message : String(error)}`, current: 0, total: 0 });
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const percent = progress?.total ? Math.min(100, Math.round(progress.current / progress.total * 100)) : 0;

  return <div className="grid gap-4">
    {IS_STATIC_PWA && <section className="rounded-xl border border-border-soft bg-surface-2 p-4">
      <h3 className="text-sm font-semibold">导入到当前设备</h3>
      <p className="mt-1 text-xs leading-5 text-muted">所有资料包都按增量方式合并：同一条目更新，不在包中的旧资料不会被删除。</p>
      <input ref={importInput} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importPackage(event.target.files?.[0])} />
      <Button className="mt-3" variant="outline" disabled={busy} onClick={() => importInput.current?.click()}><FileUp />选择便携资料包并导入</Button>
    </section>}
    {!IS_STATIC_PWA && <section className="rounded-xl border border-border-soft bg-surface-2 p-4">
      <h3 className="text-sm font-semibold">导出资料包</h3>
      <p className="mt-1 text-xs leading-5 text-muted">外置包只包含已缓存的压缩缩略图，不保存或下载第三方原图。增量导出需要选择上一次的新版资料包作为可靠基线。</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(220px,1fr)_auto]">
        <Select value={choice} onChange={(event) => { setChoice(event.target.value as ExportChoice); setBaseline(null); }}>{OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</Select>
        <Button disabled={busy || (incremental && !baseline) || (includesExternal && selectedSources.length === 0)} onClick={() => void exportPackage()}><Download />导出便携资料包</Button>
      </div>

      {includesExternal && <div className="mt-3 rounded-xl border border-border-soft bg-surface-1 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold"><Database className="size-4 text-accent" />选择外置资料库 <span className="text-xs font-normal text-muted">{selectedSources.length}/{leafSources.length}</span></div>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelectedSources(leafSources.map((source) => source.id))}>全选</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelectedSources([])}>清空</Button>
          </div>
        </div>
        {sourceError && <p className="mt-2 text-xs text-danger">读取外置资料源失败：{sourceError}</p>}
        {!sourceError && sources.length === 0 && <p className="mt-2 text-xs text-muted">正在读取外置资料源……</p>}
        <div className="mt-2 grid max-h-64 gap-1 overflow-y-auto pr-1 sm:grid-cols-2">
          {sources.map((source) => {
            const ids = source.is_collection ? leafIdsUnder(source.id) : [source.id];
            const selectedCount = ids.filter((id) => selectedSources.includes(id)).length;
            const checked = ids.length > 0 && selectedCount === ids.length;
            return <label key={source.id} className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-surface-2 ${source.parent_id ? "ml-4" : ""}`}>
              <input type="checkbox" checked={checked} disabled={busy || ids.length === 0} onChange={(event) => toggleSource(source, event.target.checked)} className="accent-[var(--accent)]" />
              <span className="min-w-0 flex-1 truncate">{source.title}</span>
              <span className="shrink-0 text-xs text-muted">{source.entry_count.toLocaleString()} 条{source.is_collection && selectedCount > 0 && selectedCount < ids.length ? ` · ${selectedCount}/${ids.length}` : ""}</span>
            </label>;
          })}
        </div>
      </div>}

      {incremental && <div className="mt-3 flex flex-wrap items-center gap-2">
        <input ref={baselineInput} type="file" accept="application/json,.json" className="hidden" onChange={(event) => setBaseline(event.target.files?.[0] || null)} />
        <Button variant="outline" size="sm" disabled={busy} onClick={() => baselineInput.current?.click()}><FileUp />选择上次导出的文件</Button>
        <span className="max-w-full truncate text-xs text-muted">{baseline?.name || "尚未选择基线文件"}</span>
      </div>}

      {progress && <div className="mt-3 rounded-xl border border-border-soft bg-surface-1 p-3" role="status" aria-live="polite">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="truncate text-fg-2">{progress.phase}</span>
          <span className="shrink-0 text-muted">{progress.total ? `${percent}%` : busy ? "处理中" : ""}</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
          {progress.total ? <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${percent}%` }} /> : <div className={`h-full w-1/3 rounded-full bg-accent ${busy ? "animate-pulse" : "opacity-50"}`} />}
        </div>
        {lastJob?.status === "complete" && <p className="mt-2 text-xs text-muted">{lastJob.filename} · {formatBytes(lastJob.bytes)} · 本地 {lastJob.local_count || 0} 条 · 外置 {lastJob.external_count || 0} 条</p>}
      </div>}
    </section>}
  </div>;
}
