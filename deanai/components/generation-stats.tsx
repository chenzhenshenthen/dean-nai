"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, Clock3, Database, ImageIcon, PieChart } from "lucide-react";
import { FeatureShell } from "@/components/feature-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { recipeFromMetadata, type PortableMetadata } from "@/lib/gallery-recipe";
import { initializeGenerationLedger, type GenerationLedger } from "@/lib/generation-counter";
import { estimateGenerationCost, modelLabel } from "@/lib/nai/models";
import { useStore } from "@/lib/store";
import { useAppPreferences } from "@/lib/use-app-preferences";

type DiskHistory = {
  timestamp: string;
  size: number;
  width: number;
  height: number;
  metadata: PortableMetadata;
};
type DiskStats = {
  total: number;
  bytes: number;
  with_prompt: number;
  generated_total: number;
  history: DiskHistory[];
};
type StatImage = {
  timestamp: string;
  size: number;
  settings: ReturnType<typeof recipeFromMetadata>;
  seed: number;
};
type DistributionKind = "model" | "sampler" | "aspect" | "resolution";

const EMPTY_LEDGER: GenerationLedger = { total: 0, generated: [], retained: [], generatedSeeded: false, retainedSeeded: false };
const DONUT_COLORS = ["var(--accent)", "#f59e0b", "#22c55e", "#38bdf8", "#a78bfa", "#fb7185", "#14b8a6", "#f97316", "#64748b"];
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function dayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function dateFromKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, Math.max(0, month - 1), day || 1, 12);
}

function shiftDate(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function dateInput(value: Date): string {
  return dayKey(value);
}

function inclusiveDays(from: string, to: string): { key: string; label: string }[] {
  if (!from || !to) return [];
  let start = dateFromKey(from);
  let end = dateFromKey(to);
  if (start > end) [start, end] = [end, start];
  const values: { key: string; label: string }[] = [];
  for (let cursor = start; cursor <= end && values.length < 366; cursor = shiftDate(cursor, 1)) {
    values.push({ key: dateInput(cursor), label: `${cursor.getMonth() + 1}/${cursor.getDate()}` });
  }
  return values;
}

function countByDay(timestamps: string[]): Map<string, number> {
  const values = new Map<string, number>();
  for (const timestamp of timestamps) {
    const key = dayKey(timestamp);
    if (key) values.set(key, (values.get(key) || 0) + 1);
  }
  return values;
}

function gcd(left: number, right: number): number {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function aspectLabel(width: number, height: number): string {
  if (!width || !height) return "未知";
  const divisor = gcd(width, height);
  const ratio = `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
  if (width === height) return `方图 · ${ratio}`;
  return width > height ? `横图 · ${ratio}` : `竖图 · ${ratio}`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 MB";
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function SectionTitle({ icon: Icon, children, aside }: { icon: typeof Activity; children: React.ReactNode; aside?: React.ReactNode }) {
  return <header className="flex flex-wrap items-center gap-3">
    <span className="grid size-9 place-items-center rounded-lg bg-accent/12 text-accent"><Icon className="size-4" /></span>
    <h2 className="font-semibold">{children}</h2>
    {aside && <div className="ml-auto">{aside}</div>}
  </header>;
}

function ActivityHeatmap({ timestamps }: { timestamps: string[] }) {
  const counts = useMemo(() => countByDay(timestamps), [timestamps]);
  const weeks = useMemo(() => {
    const today = new Date();
    const mondayOffset = (today.getDay() + 6) % 7;
    const start = shiftDate(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12), -mondayOffset - 15 * 7);
    return Array.from({ length: 16 }, (_, week) =>
      Array.from({ length: 7 }, (_, weekday) => {
        const date = shiftDate(start, week * 7 + weekday);
        const key = dayKey(date);
        return { key, count: counts.get(key) || 0, future: date > today };
      }),
    );
  }, [counts]);
  const peak = Math.max(1, ...weeks.flat().map((day) => day.count));
  const color = (count: number, future: boolean) => {
    if (future) return "transparent";
    if (!count) return "var(--surface-3)";
    const level = Math.ceil(count / peak * 4);
    return ["color-mix(in oklab,var(--accent) 28%,var(--surface-3))", "color-mix(in oklab,var(--accent) 48%,var(--surface-3))", "color-mix(in oklab,var(--accent) 70%,var(--surface-3))", "var(--accent)"][level - 1];
  };
  return <div className="mt-5 overflow-x-auto pb-1">
    <div className="min-w-[570px] space-y-1.5">
      {WEEKDAYS.map((label, weekday) => <div key={label} className="grid grid-cols-[34px_repeat(16,minmax(18px,1fr))] gap-1.5">
        <span className="self-center text-[10px] text-muted">{label}</span>
        {weeks.map((week) => {
          const day = week[weekday];
          return <span
            key={day.key}
            title={`${day.key} · 生成 ${day.count} 张`}
            className="aspect-square rounded-[4px] border border-border-soft"
            style={{ background: color(day.count, day.future), opacity: day.future ? 0.25 : 1 }}
          />;
        })}
      </div>)}
      <div className="flex items-center justify-end gap-1.5 pt-2 text-[10px] text-muted">
        <span>少</span>{[18, 36, 58, 82].map((mix) => <span key={mix} className="size-3 rounded-sm" style={{ background: `color-mix(in oklab,var(--accent) ${mix}%,var(--surface-3))` }} />)}<span>多</span>
      </div>
    </div>
  </div>;
}

function HourRadar({ timestamps }: { timestamps: string[] }) {
  const buckets = useMemo(() => {
    const values = Array(8).fill(0) as number[];
    for (const timestamp of timestamps) {
      const date = new Date(timestamp);
      if (Number.isFinite(date.getTime())) values[Math.floor(date.getHours() / 3)] += 1;
    }
    return values;
  }, [timestamps]);
  const peak = Math.max(1, ...buckets);
  const peakIndex = buckets.indexOf(Math.max(...buckets));
  const point = (index: number, radius: number) => {
    const angle = index / 8 * Math.PI * 2 - Math.PI / 2;
    return [110 + Math.cos(angle) * radius, 110 + Math.sin(angle) * radius];
  };
  const polygon = buckets.map((count, index) => point(index, 24 + count / peak * 58).join(",")).join(" ");
  return <div className="mt-3 grid items-center gap-2 sm:grid-cols-[230px_1fr]">
    <svg viewBox="0 0 220 220" className="mx-auto size-[220px] overflow-visible" role="img" aria-label="每三小时生成数量分布">
      {[28, 52, 80].map((radius) => <polygon key={radius} points={Array.from({ length: 8 }, (_, index) => point(index, radius).join(",")).join(" ")} fill="none" stroke="var(--border-soft)" strokeWidth="1" />)}
      {Array.from({ length: 8 }, (_, index) => {
        const [x, y] = point(index, 94);
        const [x2, y2] = point(index, 80);
        return <g key={index}><line x1="110" y1="110" x2={x2} y2={y2} stroke="var(--border-soft)" /><text x={x} y={y + 3} textAnchor="middle" className="fill-muted text-[9px]">{String(index * 3).padStart(2, "0")}</text></g>;
      })}
      <polygon points={polygon} fill="color-mix(in oklab,var(--accent) 28%,transparent)" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
      {buckets.map((count, index) => { const [x, y] = point(index, 24 + count / peak * 58); return <circle key={index} cx={x} cy={y} r="2.5" fill="var(--accent)"><title>{String(index * 3).padStart(2, "0")}:00–{String((index * 3 + 3) % 24).padStart(2, "0")}:00 · {count} 张</title></circle>; })}
    </svg>
    <div className="rounded-xl border border-accent/25 bg-accent/10 p-4">
      <p className="text-xs text-muted">活跃高峰</p>
      <strong className="mt-1 block text-xl text-accent">{String(peakIndex * 3).padStart(2, "0")}:00–{String((peakIndex * 3 + 3) % 24).padStart(2, "0")}:00</strong>
      <small className="mt-1 block text-muted">{buckets[peakIndex] || 0} 张生成记录</small>
    </div>
  </div>;
}

function DonutDistribution({ images }: { images: StatImage[] }) {
  const [kind, setKind] = useState<DistributionKind>("model");
  const entries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const image of images) {
      let label = "";
      if (kind === "model") label = modelLabel(image.settings.model, true);
      else if (kind === "sampler") label = image.settings.sampler || "未知采样器";
      else if (kind === "aspect") label = aspectLabel(image.settings.width, image.settings.height);
      else label = image.settings.width && image.settings.height ? `${image.settings.width}×${image.settings.height}` : "未知分辨率";
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    if (sorted.length <= 8) return sorted;
    return [...sorted.slice(0, 8), ["其他", sorted.slice(8).reduce((sum, [, count]) => sum + count, 0)] as [string, number]];
  }, [images, kind]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  let cursor = 0;
  const gradient = entries.length ? entries.map(([, count], index) => {
    const start = cursor;
    cursor += count / Math.max(1, total) * 100;
    return `${DONUT_COLORS[index % DONUT_COLORS.length]} ${start}% ${cursor}%`;
  }).join(",") : "var(--surface-3) 0 100%";
  return <section className="rounded-2xl border border-border-soft bg-surface p-5">
    <SectionTitle icon={PieChart} aside={<Select className="h-9 min-w-36 text-xs" value={kind} onChange={(event) => setKind(event.target.value as DistributionKind)}><option value="model">模型</option><option value="sampler">采样器</option><option value="aspect">画面比例</option><option value="resolution">分辨率</option></Select>}>参数分布</SectionTitle>
    <div className="mt-5 grid items-center gap-6 md:grid-cols-[220px_1fr]">
      <div className="relative mx-auto size-48 rounded-full" style={{ background: `conic-gradient(${gradient})` }}>
        <div className="absolute inset-10 grid place-items-center rounded-full bg-surface text-center shadow-inner"><div><strong className="block text-2xl">{total}</strong><small className="text-muted">留存图片</small></div></div>
      </div>
      <div className="grid gap-2.5">
        {entries.length ? entries.map(([label, count], index) => <div key={label} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2 text-xs">
          <span className="size-2.5 rounded-full" style={{ background: DONUT_COLORS[index % DONUT_COLORS.length] }} />
          <span className="truncate" title={label}>{label}</span>
          <span className="tabular-nums text-muted">{count} · {(count / total * 100).toFixed(1)}%</span>
        </div>) : <p className="text-sm text-muted">还没有可统计的留存图片。</p>}
      </div>
    </div>
  </section>;
}

export function GenerationStats({ active = true }: { active?: boolean }) {
  const accountStatus = useStore((state) => state.accountStatus);
  const retainedImages = useStore((state) => state.images);
  const { preferences, patch } = useAppPreferences();
  const detectedOpus = Boolean(accountStatus?.active && accountStatus.tier === 3);
  const useOpusPricing = detectedOpus || preferences.assumeOpusFreeImages;
  const [disk, setDisk] = useState<DiskStats | null>(null);
  const [diskReady, setDiskReady] = useState(false);
  const [ledger, setLedger] = useState<GenerationLedger>(EMPTY_LEDGER);
  const [summaryScope, setSummaryScope] = useState<"total" | "today">("total");
  const [dateFrom, setDateFrom] = useState(() => dateInput(shiftDate(new Date(), -13)));
  const [dateTo, setDateTo] = useState(() => dateInput(new Date()));

  useEffect(() => {
    if (!active) return;
    setDiskReady(false);
    void fetch("/api/local-gallery/stats")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then(setDisk)
      .catch(() => setDisk(null))
      .finally(() => setDiskReady(true));
  }, [active]);

  useEffect(() => {
    if (!diskReady) return;
    const generatedSeeds = retainedImages.length
      ? retainedImages.map((image) => ({ id: image.id, timestamp: image.timestamp, filename: image.filename }))
      : (disk?.history || []).map((image) => image.timestamp);
    setLedger(initializeGenerationLedger(
      Math.max(retainedImages.length, disk?.generated_total || 0),
      generatedSeeds,
      disk?.generated_total || 0,
      (disk?.history || []).map((image) => image.timestamp),
      true,
    ));
  }, [disk, diskReady, retainedImages]);

  const images = useMemo<StatImage[]>(() => {
    if (disk) return disk.history.map((image) => {
      const settings = recipeFromMetadata(image.metadata, image.width, image.height);
      return { timestamp: image.timestamp, size: image.size || 0, settings, seed: settings.seed };
    });
    return retainedImages.map((image) => ({
      timestamp: image.timestamp,
      size: Math.floor(((image.dataUrl.split(",", 2)[1] || "").length * 3) / 4),
      settings: image.settings,
      seed: image.seed,
    }));
  }, [disk, retainedImages]);

  const stats = useMemo(() => {
    let steps = 0;
    let pixels = 0;
    let bytes = 0;
    let anlas = 0;
    let opus = 0;
    for (const image of images) {
      steps += image.settings.steps;
      pixels += image.settings.width * image.settings.height;
      bytes += image.size;
      const perImage = { ...image.settings, nSamples: 1, seed: image.seed };
      anlas += estimateGenerationCost(perImage, false);
      opus += estimateGenerationCost(perImage, true, Boolean(accountStatus?.opusUsage?.isNegative));
    }
    return {
      anlas,
      opus,
      averageSteps: images.length ? steps / images.length : 0,
      averageMp: images.length ? pixels / images.length / 1_000_000 : 0,
      averageBytes: images.length ? bytes / images.length : 0,
    };
  }, [accountStatus?.opusUsage?.isNegative, images]);

  const generatedTimestamps = useMemo(() => ledger.generated.map((event) => event.timestamp), [ledger.generated]);
  const generatedDays = useMemo(() => countByDay(generatedTimestamps), [generatedTimestamps]);
  const retainedIds = useMemo(() => new Set(ledger.retained.map((event) => event.id)), [ledger.retained]);
  const chartDays = useMemo(() => inclusiveDays(dateFrom, dateTo).map((day) => {
    const generatedEvents = ledger.generated.filter((event) => dayKey(event.timestamp) === day.key);
    const retained = generatedEvents.filter((event) => retainedIds.has(event.id)).length;
    const generated = generatedEvents.length;
    return { ...day, retained, unretained: Math.max(0, generated - retained), generated };
  }), [dateFrom, dateTo, ledger.generated, retainedIds]);
  const chartPeak = Math.max(1, ...chartDays.map((day) => day.generated));
  const todayKey = dayKey(new Date());
  const todayGenerated = generatedDays.get(todayKey) || 0;
  const todayRetained = ledger.retained.filter((event) => dayKey(event.timestamp) === todayKey).length;
  const legacyUndated = Math.max(0, ledger.total - ledger.generated.length);
  const card = "rounded-2xl border border-border-soft bg-surface p-5";

  const quickRange = (days: number) => {
    const end = new Date();
    setDateTo(dateInput(end));
    setDateFrom(dateInput(shiftDate(end, -(days - 1))));
  };

  return <FeatureShell current="/stats/" title="生成统计" description="生成成功即计入生成；首次下载或自动保存成功即计入留存，重复下载不重复计算。">
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <section className={card}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted"><ImageIcon className="size-4" />本程序图片</div>
          <div className="flex rounded-lg bg-surface-2 p-0.5 text-[10px]">
            {(["total", "today"] as const).map((scope) => <button key={scope} type="button" onClick={() => setSummaryScope(scope)} className={`rounded-md px-2.5 py-1 transition-colors ${summaryScope === scope ? "bg-accent text-on-accent" : "text-muted hover:text-fg"}`}>{scope === "total" ? "累计" : "今日"}</button>)}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
          <span className="text-xs text-muted">{summaryScope === "total" ? "累计生成" : "今日生成"}</span><strong className="text-2xl tabular-nums">{summaryScope === "total" ? ledger.total : todayGenerated}</strong>
          <span className="text-xs text-muted">{summaryScope === "total" ? "累计留存" : "今日留存"}</span><strong className="text-2xl tabular-nums">{summaryScope === "total" ? ledger.retained.length : todayRetained}</strong>
        </div>
        {summaryScope === "total" && legacyUndated > 0 && <small className="mt-3 block text-muted">另有 {legacyUndated} 张旧生成记录没有可还原日期</small>}
      </section>
      <section className={card}>
        <div className="flex items-center justify-between gap-2"><p className="flex items-center gap-2 text-xs text-muted"><BarChart3 className="size-4" />留存图片估算 Anlas</p><label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted"><Switch checked={useOpusPricing} disabled={detectedOpus} onCheckedChange={(assumeOpusFreeImages) => patch({ assumeOpusFreeImages })} />会员小图免费</label></div>
        <strong className="mt-4 block text-3xl tabular-nums">{useOpusPricing ? stats.opus : stats.anlas}</strong>
        <small className="text-muted">{useOpusPricing ? "按会员免费条件估算" : "普通计费估算"} · 已删除图片不含参数</small>
      </section>
      <section className={card}>
        <p className="flex items-center gap-2 text-xs text-muted"><Activity className="size-4" />平均参数</p>
        <strong className="mt-4 block text-xl">{stats.averageSteps.toFixed(1)} steps</strong>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"><span>{stats.averageMp.toFixed(2)} MP</span><span>{formatBytes(stats.averageBytes)} / 张</span></div>
      </section>
      <section className={card}>
        <p className="flex items-center gap-2 text-xs text-muted"><Database className="size-4" />电脑画廊索引</p>
        <strong className="mt-4 block text-3xl tabular-nums">{disk?.total ?? "—"}</strong>
        <small className="text-muted">{disk ? `${formatBytes(disk.bytes)} · ${disk.with_prompt} 张含提示词` : "正在读取"}</small>
      </section>
    </div>

    <div className="mt-4 grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
      <section className={card}><SectionTitle icon={Activity}>活力热力图</SectionTitle><ActivityHeatmap timestamps={generatedTimestamps} /></section>
      <section className={card}><SectionTitle icon={Clock3}>小时分布</SectionTitle><HourRadar timestamps={generatedTimestamps} /></section>
    </div>

    <section className={`${card} mt-4`}>
      <SectionTitle icon={BarChart3} aside={<div className="flex flex-wrap gap-1.5"><Button size="sm" variant="outline" onClick={() => quickRange(14)}>14 日</Button><Button size="sm" variant="outline" onClick={() => quickRange(30)}>30 日</Button><Button size="sm" variant="outline" onClick={() => quickRange(90)}>90 日</Button></div>}>每日生成与留存</SectionTitle>
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(150px,220px)_minmax(150px,220px)_1fr]">
        <label className="grid gap-1 text-xs text-muted">开始日期<Input type="date" value={dateFrom} max={dateTo} onChange={(event) => setDateFrom(event.target.value)} /></label>
        <label className="grid gap-1 text-xs text-muted">结束日期<Input type="date" value={dateTo} min={dateFrom} onChange={(event) => setDateTo(event.target.value)} /></label>
        <div className="flex items-end justify-start gap-4 pb-3 text-xs text-muted sm:justify-end"><span className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-accent" />已留存</span><span className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-orange-500" />尚未留存</span></div>
      </div>
      <div className="mt-5 overflow-x-auto pb-2">
        <div className="flex h-64 items-end gap-2" style={{ minWidth: `${Math.max(720, chartDays.length * 42)}px` }}>
          {chartDays.map((day) => {
            const retainedHeight = day.retained / chartPeak * 180;
            const unretainedHeight = day.unretained / chartPeak * 180;
            return <div key={day.key} className="flex min-w-0 flex-1 flex-col items-center">
              <span className="mb-1 h-4 text-[9px] tabular-nums text-muted">{day.generated || ""}</span>
              <div className="flex h-[180px] w-full max-w-12 flex-col justify-end overflow-hidden rounded-t-md" title={`${day.key} · 生成 ${day.generated} · 已留存 ${day.retained} · 尚未留存 ${day.unretained}`}>
                {day.unretained > 0 && <div className="w-full bg-orange-500/85" style={{ height: `${Math.max(4, unretainedHeight)}px` }} />}
                {day.retained > 0 && <div className="w-full bg-accent/85" style={{ height: `${Math.max(4, retainedHeight)}px` }} />}
                {!day.generated && <div className="h-px w-full bg-border-soft" />}
              </div>
              <span className="mt-2 text-[9px] text-muted">{day.label}</span>
            </div>;
          })}
        </div>
      </div>
    </section>

    <div className="mt-4">
      <DonutDistribution images={images} />
    </div>
  </FeatureShell>;
}
