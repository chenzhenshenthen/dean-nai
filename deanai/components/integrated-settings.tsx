"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowLeft, CircleAlert, Database, Dices, FolderOpen, GripVertical, HardDriveDownload, Info, Keyboard, KeyRound, Monitor, Plus, RefreshCw, RotateCcw, ShieldAlert, SlidersHorizontal, Trash2, Wifi } from "lucide-react";
import { toast } from "sonner";
import { AccentPicker } from "@/components/accent-picker";
import { FeatureShell } from "@/components/feature-shell";
import { RandomDirectorySelector } from "@/components/random-directory-selector";
import { MobileLibrarySync } from "@/components/mobile-library-sync";
import { AutomaticGenerationSettings } from "@/components/automatic-generation-settings";
import { AccountStatusPanel } from "@/components/account-status-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TokenInput } from "@/components/token-input";
import { hasNovelAITokenFormat, normalizeNovelAIToken } from "@/lib/nai/token";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { DEFAULT_CONNECTION, loadConnection } from "@/lib/nai/client";
import { NAV_EDIT_EVENT, resetNavigationOrder, setNavigationEditMode } from "@/lib/navigation-order";
import { DEFAULT_APP_PREFERENCES, FILENAME_PLACEHOLDERS, loadAppPreferences, renderFilename, saveAppPreferences, unknownFilenamePlaceholders, type AppPreferences } from "@/lib/app-preferences";
import { ACCENTS, applyAccent, applyMode, currentAccent, currentMode, type Mode } from "@/lib/theme";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { DEFAULT_RANDOM_LIBRARY_PREFERENCES, loadRandomLibraryPreferences, saveRandomLibraryPreferences, type RandomKindPreferences, type RandomLibraryPreferences } from "@/lib/random-library";
import { DEFAULT_LOCAL_GALLERY_SHORTCUTS, LOCAL_GALLERY_SHORTCUT_ACTIONS, formatShortcut, loadLocalGalleryShortcuts, saveLocalGalleryShortcuts, shortcutFromEvent, type LocalGalleryShortcutAction, type LocalGalleryShortcuts } from "@/lib/local-gallery-shortcuts";

type LocalSettings = {
  gallery_roots: string[];
  gallery_extensions: string[];
  online_timeout: number;
  gallery_page_size: number;
  auto_scan_on_start: boolean;
  recursive_scan: boolean;
  gelbooru_user_id: string;
  gelbooru_api_key: string;
  log_retention_days: number;
};

const IS_STATIC_PWA = process.env.NEXT_PUBLIC_STATIC_PWA === "1";
const PWA_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

const localDefaults: LocalSettings = {
  gallery_roots: [], gallery_extensions: [".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov", ".m4v"], online_timeout: 20,
  gallery_page_size: 300, auto_scan_on_start: false, recursive_scan: false, gelbooru_user_id: "", gelbooru_api_key: "", log_retention_days: 30,
};

type SectionKey = "account" | "output" | "protection" | "random" | "gallery" | "shortcuts" | "online" | "interface" | "mobile-data" | "logs" | "about";
const SECTIONS: { key: SectionKey; label: string; icon: typeof KeyRound }[] = [
  { key: "account", label: "\u004e\u006f\u0076\u0065\u006c\u0041\u0049 \u8d26\u53f7", icon: KeyRound },
  { key: "output", label: "\u4fdd\u5b58\u4e0e\u6587\u4ef6\u540d", icon: HardDriveDownload },
  { key: "protection", label: "\u6d88\u8017\u4e0e\u4fdd\u62a4", icon: ShieldAlert },
  { key: "random", label: "资料库与随机", icon: Dices },
  { key: "gallery", label: "\u672c\u5730\u753b\u5eca", icon: FolderOpen },
  { key: "shortcuts", label: "画廊快捷键", icon: Keyboard },
  { key: "online", label: "\u5728\u7ebf\u753b\u5eca", icon: Wifi },
  { key: "interface", label: "\u754c\u9762", icon: Monitor },
  { key: "mobile-data", label: "便携资料", icon: Database },
  { key: "logs", label: "\u65e5\u5fd7\u4e0e\u6570\u636e", icon: SlidersHorizontal },
  { key: "about", label: "\u5173\u4e8e", icon: Info },
];

type DesktopApi = { pick_folder?: () => Promise<string | null> };
function desktopApi(): DesktopApi | undefined {
  return (window as typeof window & { pywebview?: { api?: DesktopApi } }).pywebview?.api;
}

function SettingsCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <section className="rounded-xl border border-border-soft bg-surface p-5">
    <h2 className="font-semibold">{title}</h2>
    {description && <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>}
    <div className="mt-4">{children}</div>
  </section>;
}

export function IntegratedSettings() {
  const connect = useStore((state) => state.connect);
  const status = useStore((state) => state.connectionStatus);
  const refreshAccount = useStore((state) => state.refreshAnlas);
  const [section, setSection] = useState<SectionKey>("account");
  const [localSettings, setLocalSettings] = useState<LocalSettings>(localDefaults);
  const [extensions, setExtensions] = useState(localDefaults.gallery_extensions.join(", "));
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_APP_PREFERENCES);
  const [galleryShortcuts, setGalleryShortcuts] = useState<LocalGalleryShortcuts>(() => loadLocalGalleryShortcuts());
  const [randomPreferences, setRandomPreferences] = useState<RandomLibraryPreferences>(DEFAULT_RANDOM_LIBRARY_PREFERENCES);
  const [token, setToken] = useState("");
  const [maxRetries, setMaxRetries] = useState(DEFAULT_CONNECTION.maxRetries);
  const [baseDelay, setBaseDelay] = useState(DEFAULT_CONNECTION.baseDelay);
  const [mode, setMode] = useState<Mode>("dark");
  const [accent, setAccent] = useState("default");
  const [busy, setBusy] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [navigationEditing, setNavigationEditing] = useState(false);
  const preferencesHydrated = useRef(false);
  const randomHydrated = useRef(false);
  const localHydrated = useRef(false);

  useEffect(() => {
    void fetch("/api/integrated-settings").then((response) => response.ok ? response.json() : Promise.reject()).then((value: LocalSettings) => {
      setLocalSettings({ ...localDefaults, ...value });
      setExtensions((value.gallery_extensions || localDefaults.gallery_extensions).join(", "));
      localHydrated.current = true;
    }).catch(() => undefined);
    queueMicrotask(() => {
      const connection = loadConnection();
      if (connection) { setToken(connection.token); setMaxRetries(connection.maxRetries); setBaseDelay(connection.baseDelay); }
      setPreferences(loadAppPreferences()); preferencesHydrated.current = true;
      setMode(currentMode()); setAccent(currentAccent()); setIsDesktop(Boolean(desktopApi()));
      setRandomPreferences(loadRandomLibraryPreferences()); randomHydrated.current = true;
    });
  }, []);

  useEffect(() => {
    const handleNavigationEditing = (event: Event) => setNavigationEditing(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(NAV_EDIT_EVENT, handleNavigationEditing);
    return () => window.removeEventListener(NAV_EDIT_EVENT, handleNavigationEditing);
  }, []);
  useEffect(() => {
    if (!preferencesHydrated.current || unknownFilenamePlaceholders(preferences.filenameTemplate).length) return;
    const timer = window.setTimeout(() => saveAppPreferences(preferences), 250);
    return () => window.clearTimeout(timer);
  }, [preferences]);

  useEffect(() => {
    if (!randomHydrated.current) return;
    const timer = window.setTimeout(() => saveRandomLibraryPreferences(randomPreferences), 250);
    return () => window.clearTimeout(timer);
  }, [randomPreferences]);

  useEffect(() => {
    if (!localHydrated.current) return;
    const timer = window.setTimeout(async () => {
      const payload = {
        ...localSettings,
        gallery_extensions: extensions.split(/[,;\s]+/).filter(Boolean).map((item) => item.startsWith(".") ? item.toLowerCase() : "." + item.toLowerCase()),
      };
      try {
        const response = await fetch("/api/integrated-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        if (!response.ok) throw new Error((await response.json()).error || "Save failed");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [extensions, localSettings]);

  const templateUnknown = useMemo(() => unknownFilenamePlaceholders(preferences.filenameTemplate), [preferences.filenameTemplate]);
  const filenameExample = useMemo(() => renderFilename(preferences.filenameTemplate, {
    artistName: "\u793a\u4f8b\u753b\u5e08\u4e32", sceneName: "\u793a\u4f8b\u573a\u666f", timestamp: new Date(2026, 7, 28, 21, 30, 45), index: 1,
  }), [preferences.filenameTemplate]);
  const patchPreferences = (patch: Partial<AppPreferences>) => setPreferences((current) => ({ ...current, ...patch }));
  const assignGalleryShortcut = (action: LocalGalleryShortcutAction, event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const shortcut = event.key === "Backspace" ? "" : shortcutFromEvent(event);
    if (event.key !== "Backspace" && !shortcut) return;
    setGalleryShortcuts((current) => {
      const next = { ...current };
      for (const key of Object.keys(next) as LocalGalleryShortcutAction[]) {
        if (key !== action && shortcut && next[key] === shortcut) next[key] = "";
      }
      next[action] = shortcut;
      return saveLocalGalleryShortcuts(next);
    });
  };

  async function chooseFolder(target: "output" | "gallery") {
    const picker = desktopApi()?.pick_folder;
    if (!picker) { toast.info("\u6d4f\u89c8\u5668\u6a21\u5f0f\u9700\u624b\u52a8\u586b\u5199\u8def\u5f84\uff1bEXE \u53ef\u4f7f\u7528\u7cfb\u7edf\u9009\u62e9\u5668\u3002"); return; }
    setBusy(true);
    try {
      const path = await picker(); if (!path) return;
      if (target === "output") patchPreferences({ saveDirectory: path });
      else setLocalSettings((current) => ({ ...current, gallery_roots: current.gallery_roots.includes(path) ? current.gallery_roots : [...current.gallery_roots, path] }));
    } finally { setBusy(false); }
  }

  async function saveConnectionSettings() {
    const normalized = normalizeNovelAIToken(token);
    if (!hasNovelAITokenFormat(normalized)) { toast.error("请粘贴完整的 pst- Token，不能使用圆点或省略号代替。"); return; }
    setToken(normalized);
    await connect({ token: normalized, host: DEFAULT_CONNECTION.host, maxRetries, baseDelay });
  }

  function patchRandomKind(kind: "artist" | "prompt", patch: Partial<RandomKindPreferences>) {
    setRandomPreferences((current) => ({ ...current, [kind]: { ...current[kind], ...patch } }));
  }

  async function scanNow() {
    setBusy(true);
    try {
      const response = await fetch("/api/local-gallery/scan", { method: "POST" }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Scan failed");
      toast.success(`扫描完成: +${data.added}, 更新 ${data.updated}, 移动 ${data.moved || 0}, -${data.removed}`);
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  }

  async function openLocalFolder(kind: "data" | "logs") {
    try { const response = await fetch("/api/local/open-folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) }); if (!response.ok) throw new Error(); }
    catch { toast.error("\u6b64\u529f\u80fd\u9700\u8981 dean-nai Windows \u672c\u5730\u670d\u52a1\u3002"); }
  }

  function updateRoot(index: number, value: string) {
    setLocalSettings((current) => ({ ...current, gallery_roots: current.gallery_roots.map((root, i) => i === index ? value : root) }));
  }

  return <FeatureShell current="/settings/" title={"\u8bbe\u7f6e"} description={"dean-nai \u8d26\u53f7\u3001\u4fdd\u5b58\u3001\u4fdd\u62a4\u3001\u753b\u5eca\u4e0e\u672c\u5730\u6570\u636e\u8bbe\u7f6e\u3002"}>
    {IS_STATIC_PWA && <a href={`${PWA_BASE_PATH}/`} className="mb-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-fg-2 hover:bg-surface-2 hover:text-fg"><ArrowLeft className="size-4" />返回生图</a>}
    <div className="mx-auto grid w-full max-w-6xl gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
      <nav className="h-fit rounded-xl border border-border-soft bg-surface p-2 lg:sticky lg:top-4" aria-label="Settings sections">
        {SECTIONS.map((item) => { const Icon = item.icon; return <button key={item.key} type="button" onClick={() => setSection(item.key)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors", section === item.key ? "bg-accent/15 font-semibold text-accent" : "text-muted hover:bg-surface-2 hover:text-fg")}><Icon className="size-4" />{item.label}</button>; })}
      </nav>
      <main className="grid min-w-0 gap-4">
        {section === "account" && <SettingsCard title="NovelAI Token" description="Token 保存在当前浏览器。圆点仅用于隐藏显示，不是加密后的 Token。订阅查询失败不等于生图凭据无效。">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1 text-sm sm:col-span-2"><label htmlFor="settings-nai-token">Persistent API Token</label><TokenInput id="settings-nai-token" value={token} onValueChange={setToken} placeholder="pst-..." /></div>
            <label className="grid gap-1 text-sm"><span>{"\u6700\u5927\u91cd\u8bd5\u6b21\u6570"}</span><Input type="number" min={0} max={10} value={maxRetries} onChange={(event) => setMaxRetries(Number(event.target.value) || 0)} /></label>
            <label className="grid gap-1 text-sm"><span>{"\u57fa\u7840\u91cd\u8bd5\u5ef6\u8fdf (ms)"}</span><Input type="number" min={0} max={60000} value={baseDelay} onChange={(event) => setBaseDelay(Number(event.target.value) || 0)} /></label>
          </div>
          <div className="mt-4"><AccountStatusPanel /></div>
          <div className="mt-4 flex flex-wrap gap-2"><Button onClick={() => void saveConnectionSettings()} disabled={status === "verifying"}><KeyRound />{status === "verifying" ? "\u6b63\u5728\u9a8c\u8bc1" : "\u9a8c\u8bc1\u5e76\u4fdd\u5b58 Token"}</Button><Button variant="outline" onClick={() => void refreshAccount()} disabled={status !== "ok"}><RefreshCw />{"\u5237\u65b0\u8d26\u53f7\u72b6\u6001"}</Button><Button variant="outline" onClick={() => { setMaxRetries(DEFAULT_CONNECTION.maxRetries); setBaseDelay(DEFAULT_CONNECTION.baseDelay); }}><RotateCcw />恢复重试默认值</Button></div>
        </SettingsCard>}

        {section === "output" && <SettingsCard title={"\u4fdd\u5b58\u4e0e\u6587\u4ef6\u540d"} description={"EXE \u76f4\u63a5\u5199\u5165\u9009\u5b9a\u76ee\u5f55\uff1b\u6d4f\u89c8\u5668\u7248\u4ecd\u4f7f\u7528\u6d4f\u89c8\u5668\u4e0b\u8f7d\u3002"}>
          <SwitchRow label={"\u751f\u6210\u540e\u81ea\u52a8\u4fdd\u5b58"} hint={"\u6210\u529f\u751f\u6210\u540e\u81ea\u52a8\u4e0b\u8f7d\u6216\u5199\u5165\u76ee\u5f55\u3002"} checked={preferences.autoSave} onCheckedChange={(autoSave) => patchPreferences({ autoSave })} />
          <div className="mt-4 grid gap-2"><label className="text-sm">{"\u4fdd\u5b58\u76ee\u5f55"}</label><div className="flex gap-2"><Input value={preferences.saveDirectory} onChange={(event) => patchPreferences({ saveDirectory: event.target.value })} placeholder={isDesktop ? "C:\\Pictures\\dean-nai" : "\u6d4f\u89c8\u5668\u6a21\u5f0f\u7531\u4e0b\u8f7d\u8bbe\u7f6e\u51b3\u5b9a"} /><Button variant="outline" onClick={() => void chooseFolder("output")} disabled={busy}><FolderOpen />{"\u9009\u62e9"}</Button></div></div>
          <div className="mt-4 grid gap-2"><div className="flex items-center gap-2 text-sm"><span>{"\u4e0b\u8f7d\u6587\u4ef6\u540d\u6a21\u677f"}</span><button type="button" className="grid size-5 place-items-center rounded-full border border-border text-xs" onClick={() => toast.info(FILENAME_PLACEHOLDERS.map((item) => `{{${item}}}`).join("  "))} title={`${FILENAME_PLACEHOLDERS.map((item) => `{{${item}}}`).join("  ")}\n\u5360\u4f4d\u7b26\u4f1a\u5728\u4fdd\u5b58\u65f6\u66ff\u6362\uff0c\u4e0d\u8981\u586b xxx\u3002`}>!</button></div><Input value={preferences.filenameTemplate} onChange={(event) => patchPreferences({ filenameTemplate: event.target.value })} />
            {templateUnknown.length > 0 && <p className="flex items-center gap-2 text-xs text-danger"><CircleAlert />{"\u672a\u77e5\u5360\u4f4d\u7b26"}: {templateUnknown.join(", ")}</p>}<p className="break-all text-xs text-muted">{"\u9884\u89c8"}: {filenameExample}</p></div>
          <div className="mt-4"><Button variant="outline" onClick={() => setPreferences(DEFAULT_APP_PREFERENCES)}><RotateCcw />{"\u6062\u590d\u9ed8\u8ba4"}</Button></div>
        </SettingsCard>}

        {section === "protection" && <SettingsCard title={"\u6d88\u8017\u4e0e\u4fdd\u62a4"} description={"\u9ad8\u6d88\u8017\u8b66\u544a\u548c\u751f\u6210\u95f4\u9694\u5728\u751f\u6210\u524d\u751f\u6548\u3002"}>
          <SwitchRow label="会员小图免费" hint="账号状态未能识别时，可手动按 Opus 的小图免费条件估算；不会改变 NovelAI 的实际扣费。" checked={preferences.assumeOpusFreeImages} onCheckedChange={(assumeOpusFreeImages) => patchPreferences({ assumeOpusFreeImages })} />
          <SwitchRow label={"\u9ad8\u6d88\u8017\u8b66\u544a"} checked={preferences.warnHighCost} onCheckedChange={(warnHighCost) => patchPreferences({ warnHighCost })} />
          <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm"><span>{"\u8b66\u544a\u9608\u503c (Anlas)"}</span><Input type="number" min={1} value={preferences.highCostThreshold} onChange={(event) => patchPreferences({ highCostThreshold: Number(event.target.value) || 1 })} /></label><label className="grid gap-1 text-sm"><span>{"\u751f\u6210\u95f4\u9694 (\u79d2)"}</span><Input type="number" min={0} max={3600} value={preferences.generationIntervalSeconds} onChange={(event) => patchPreferences({ generationIntervalSeconds: Number(event.target.value) || 0 })} /></label></div>
          <Button className="mt-4" variant="outline" onClick={() => setPreferences((current) => ({ ...current, warnHighCost: DEFAULT_APP_PREFERENCES.warnHighCost, highCostThreshold: DEFAULT_APP_PREFERENCES.highCostThreshold, generationIntervalSeconds: DEFAULT_APP_PREFERENCES.generationIntervalSeconds }))}><RotateCcw />{"\u6062\u590d\u9ed8\u8ba4"}</Button>
        </SettingsCard>}

        {section === "random" && <SettingsCard title="资料库与随机选择" description="Basic 中的骰子按钮只替换对应字段，不会自动开始生图。抽取目录可独立多选，并保存为可重复使用的预设。">
          <div className="mb-5 rounded-lg border border-border-soft bg-surface-2 p-4">
            <SwitchRow
              label={"\u5728\u751f\u56fe\u8d44\u6599\u5e93\u4e2d\u663e\u793a\u5916\u7f6e\u8d44\u6599\u5e93"}
              hint={"\u5f00\u542f\u540e\uff0cBasic \u4e2d\u753b\u5e08\u4e32\u548c\u573a\u666f\u63d0\u793a\u8bcd\u7684\u8d44\u6599\u5e93\u5f39\u7a97\u4f1a\u589e\u52a0\u201c\u5916\u7f6e\u8d44\u6599\u5e93\u201d\u9009\u9879\uff1b\u4f7f\u7528\u540e\u5199\u5165\u573a\u666f\u63d0\u793a\u8bcd\u3002"}
              checked={preferences.showExternalLibraryInPicker}
              onCheckedChange={(showExternalLibraryInPicker) => patchPreferences({ showExternalLibraryInPicker })}
            />
          </div>
          <AutomaticGenerationSettings preferences={preferences} onChange={patchPreferences} />
          <div className="grid gap-5">
            {(["artist", "prompt"] as const).map((kind) => {
              const value = randomPreferences[kind];
              return <section key={kind} className="rounded-lg border border-border-soft bg-surface-2 p-4">
                <h3 className="text-sm font-semibold">{kind === "artist" ? "画师串" : "场景提示词"}</h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm"><span>抽取范围</span><Select value={value.scope} onChange={(event) => patchRandomKind(kind, { scope: event.target.value as RandomKindPreferences["scope"] })}><option value="all">全库</option><option value="custom">自定义目录</option></Select></label>
                  <label className="grid gap-1 text-sm"><span>随机权重</span><Select value={value.weighting} onChange={(event) => patchRandomKind(kind, { weighting: event.target.value as RandomKindPreferences["weighting"] })}><option value="uniform">均匀随机</option><option value="rating">评分越高越常出现</option><option value="usage">使用越多越常出现</option><option value="rating_usage">评分与使用次数混合</option><option value="custom">自定义评分/使用比例</option></Select></label>
                  {kind === "artist" && <><label className="grid gap-1 text-sm"><span>最低评分（0 表示不限）</span><Input type="number" min={0} max={5} step={0.5} value={value.minRating} onChange={(event) => patchRandomKind(kind, { minRating: Number(event.target.value) || 0 })} /></label><label className="grid gap-1 text-sm"><span>最高评分</span><Input type="number" min={0.5} max={5} step={0.5} value={value.maxRating} onChange={(event) => patchRandomKind(kind, { maxRating: Number(event.target.value) || 5 })} /></label><div className="self-end pb-2"><SwitchRow label="允许抽到未评分" checked={value.includeUnrated} onCheckedChange={(includeUnrated) => patchRandomKind(kind, { includeUnrated })} /></div></>}
                  {value.weighting === "custom" && <><label className="grid gap-1 text-sm"><span>评分权重</span><Input type="number" min={0} max={10} step={0.25} value={value.ratingWeight} onChange={(event) => patchRandomKind(kind, { ratingWeight: Number(event.target.value) || 0 })} /></label><label className="grid gap-1 text-sm"><span>使用次数权重</span><Input type="number" min={0} max={10} step={0.25} value={value.usageWeight} onChange={(event) => patchRandomKind(kind, { usageWeight: Number(event.target.value) || 0 })} /></label></>}
                </div>
                {value.scope === "custom" && <RandomDirectorySelector
                  kind={kind}
                  value={value}
                  presets={randomPreferences.presets[kind]}
                  onChange={(patch) => patchRandomKind(kind, patch)}
                  onPresetsChange={(presets) => setRandomPreferences((current) => ({ ...current, presets: { ...current.presets, [kind]: presets } }))}
                />}
              </section>;
            })}
            <label className="grid max-w-xs gap-1 text-sm"><span>最近多少张不重复</span><Input type="number" min={0} max={100} value={randomPreferences.avoidRecent} onChange={(event) => setRandomPreferences((current) => ({ ...current, avoidRecent: Number(event.target.value) || 0 }))} /></label>
          </div>
          <Button className="mt-4" variant="outline" onClick={() => setRandomPreferences(DEFAULT_RANDOM_LIBRARY_PREFERENCES)}><RotateCcw />恢复默认值</Button>
        </SettingsCard>}

        {section === "gallery" && <SettingsCard title={"\u672c\u5730\u753b\u5eca"} description={"\u53ef\u914d\u7f6e\u591a\u4e2a\u76ee\u5f55\u3002\u9ed8\u8ba4\u53ea\u626b\u63cf\u6240\u9009\u76ee\u5f55\u672c\u5c42\u3002"}>
          <div className="grid gap-2">{localSettings.gallery_roots.map((root, index) => <div className="flex gap-2" key={`${index}-${root}`}><Input value={root} onChange={(event) => updateRoot(index, event.target.value)} placeholder="C:\\Pictures" /><Button size="icon" variant="outline" onClick={() => setLocalSettings((current) => ({ ...current, gallery_roots: current.gallery_roots.filter((_, i) => i !== index) }))}><Trash2 /></Button></div>)}</div>
          <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" onClick={() => void chooseFolder("gallery")} disabled={busy}><FolderOpen />{"\u9009\u62e9\u76ee\u5f55"}</Button><Button variant="outline" onClick={() => setLocalSettings((current) => ({ ...current, gallery_roots: [...current.gallery_roots, ""] }))}><Plus />{"\u624b\u52a8\u6dfb\u52a0"}</Button></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm"><span>{"\u56fe\u7247\u6269\u5c55\u540d"}</span><Input value={extensions} onChange={(event) => setExtensions(event.target.value)} /></label><label className="grid gap-1 text-sm"><span>{"\u6bcf\u9875\u6570\u91cf"}</span><Input type="number" min={60} max={1000} value={localSettings.gallery_page_size} onChange={(event) => setLocalSettings((current) => ({ ...current, gallery_page_size: Number(event.target.value) || localDefaults.gallery_page_size }))} /></label></div>
          <div className="mt-4 grid gap-3"><SwitchRow label={"\u542f\u52a8\u65f6\u81ea\u52a8\u626b\u63cf"} checked={localSettings.auto_scan_on_start} onCheckedChange={(auto_scan_on_start) => setLocalSettings((current) => ({ ...current, auto_scan_on_start }))} /><SwitchRow label={"\u9012\u5f52\u626b\u63cf\u5b50\u76ee\u5f55"} hint={"\u9ed8\u8ba4\u5173\u95ed\uff0c\u5173\u95ed\u65f6\u53ea\u8bfb\u53d6\u76ee\u5f55\u672c\u5c42\u3002"} checked={localSettings.recursive_scan} onCheckedChange={(recursive_scan) => setLocalSettings((current) => ({ ...current, recursive_scan }))} /></div>
          <div className="mt-4 flex gap-2"><Button variant="outline" onClick={() => void scanNow()} disabled={busy}><RefreshCw />{"\u7acb\u5373\u626b\u63cf"}</Button><Button variant="outline" onClick={() => { setLocalSettings((current) => ({ ...current, gallery_roots: localDefaults.gallery_roots, gallery_extensions: localDefaults.gallery_extensions, gallery_page_size: localDefaults.gallery_page_size, auto_scan_on_start: localDefaults.auto_scan_on_start, recursive_scan: localDefaults.recursive_scan })); setExtensions(localDefaults.gallery_extensions.join(", ")); }}><RotateCcw />{"\u6062\u590d\u9ed8\u8ba4"}</Button></div>
        </SettingsCard>}

        {section === "shortcuts" && <SettingsCard title="本地画廊快捷键" description="打开本地画廊图片详情后生效。点击按键框，再按下希望绑定的按键或组合键；Backspace 清除。Esc 也可以作为快捷键。">
          <div className="grid gap-3">
            {LOCAL_GALLERY_SHORTCUT_ACTIONS.map((item) => <label key={item.action} className="grid items-center gap-2 rounded-lg border border-border-soft bg-surface-2 p-3 sm:grid-cols-[minmax(0,1fr)_180px]">
              <span><strong className="block text-sm">{item.label}</strong><small className="text-muted">{item.hint}</small></span>
              <Input
                readOnly
                value={formatShortcut(galleryShortcuts[item.action])}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => assignGalleryShortcut(item.action, event)}
                className="cursor-pointer text-center font-mono"
                aria-label={"设置" + item.label + "快捷键"}
              />
            </label>)}
          </div>
          <Button className="mt-4" variant="outline" onClick={() => {
            const defaults = { ...DEFAULT_LOCAL_GALLERY_SHORTCUTS };
            setGalleryShortcuts(defaults);
            saveLocalGalleryShortcuts(defaults);
          }}><RotateCcw />恢复默认快捷键</Button>
        </SettingsCard>}
        {section === "online" && <SettingsCard title={"\u5728\u7ebf\u753b\u5eca"} description={"Danbooru \u65e0\u9700 Token\uff1bGelbooru \u8d26\u53f7\u53c2\u6570\u53ef\u9009\u3002"}>
          <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm"><span>{"\u8bf7\u6c42\u8d85\u65f6 (\u79d2)"}</span><Input type="number" min={5} max={120} value={localSettings.online_timeout} onChange={(event) => setLocalSettings((current) => ({ ...current, online_timeout: Number(event.target.value) || 20 }))} /></label><span /><label className="grid gap-1 text-sm"><span>Gelbooru User ID</span><Input value={localSettings.gelbooru_user_id} onChange={(event) => setLocalSettings((current) => ({ ...current, gelbooru_user_id: event.target.value }))} /></label><label className="grid gap-1 text-sm"><span>Gelbooru API Key</span><Input type="password" value={localSettings.gelbooru_api_key} onChange={(event) => setLocalSettings((current) => ({ ...current, gelbooru_api_key: event.target.value }))} /></label></div><Button className="mt-4" variant="outline" onClick={() => setLocalSettings((current) => ({ ...current, online_timeout: localDefaults.online_timeout, gelbooru_user_id: "", gelbooru_api_key: "" }))}><RotateCcw />{"\u6062\u590d\u9ed8\u8ba4"}</Button>
        </SettingsCard>}

        {section === "interface" && <SettingsCard title={"\u754c\u9762"}><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm"><span>{"\u4e3b\u9898"}</span><Select value={mode} onChange={(event) => { const value = event.target.value as Mode; setMode(value); applyMode(value); }}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></Select></label><label className="grid gap-1 text-sm"><span>{"\u5f3a\u8c03\u8272"}</span><Select value={accent} onChange={(event) => { setAccent(event.target.value); applyAccent(event.target.value); }}>{ACCENTS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</Select></label></div><Button className="mt-4" variant="outline" onClick={() => { setMode("dark"); setAccent("default"); applyMode("dark"); applyAccent("default"); }}><RotateCcw />恢复默认值</Button></SettingsCard>}

        {section === "interface" && <SettingsCard title={"\u5f3a\u8c03\u8272\u69fd"} description={"\u4e94\u4e2a\u989c\u8272\u69fd\u90fd\u53ef\u4fee\u6539\uff1a\u524d\u4e09\u683c\u662f\u5e38\u7528\u9884\u8bbe\uff0c\u540e\u4e24\u683c\u4fdd\u5b58\u81ea\u5b9a\u4e49\u989c\u8272\u3002"}>
          <AccentPicker />
          <p className="mt-2 text-xs text-muted">{"\u70b9\u51fb\u4efb\u4e00\u8272\u5757\u5373\u53ef\u9009\u4e2d\u5e76\u6253\u5f00\u53d6\u8272\u5668\uff0c\u4e5f\u53ef\u76f4\u63a5\u8f93\u5165\u5341\u516d\u8fdb\u5236\u989c\u8272\u3002"}</p>
        </SettingsCard>}

        {section === "interface" && <SettingsCard title="导航栏顺序" description="平时导航栏不可拖动。进入调整模式后，直接拖动左侧图标排序；离开设置页会自动退出。">
          <div className="flex flex-wrap gap-2">
            <Button variant={navigationEditing ? "default" : "outline"} onClick={() => {
              const next = !navigationEditing;
              setNavigationEditing(next);
              setNavigationEditMode(next);
            }}>
              <GripVertical />{navigationEditing ? "完成调整" : "进入调整模式"}
            </Button>
            <Button variant="outline" onClick={() => { resetNavigationOrder(); setNavigationEditing(false); setNavigationEditMode(false); }}>
              <RotateCcw />恢复默认顺序
            </Button>
          </div>
          {navigationEditing && <p className="mt-3 text-xs text-accent">现在可以拖动左侧导航图标；点击“完成调整”后恢复正常点击。</p>}
        </SettingsCard>}
        {section === "mobile-data" && <SettingsCard title="便携资料" description="将本地资料库和已缓存的外置资料导出为 JSON 资料包；资料内容不会上传到 Git。">
          <MobileLibrarySync />
        </SettingsCard>}

        {section === "logs" && <SettingsCard title={"\u65e5\u5fd7\u4e0e\u6570\u636e"} description={"\u542f\u52a8\u65e5\u5fd7\u6309\u5929\u5f52\u6863\uff0c\u540c\u4e00\u5929\u7684\u591a\u6b21\u542f\u52a8\u8ffd\u52a0\u5230\u540c\u4e00\u7ec4\u6587\u4ef6\u3002"}><label className="grid max-w-xs gap-1 text-sm"><span>{"\u65e5\u5fd7\u4fdd\u7559\u5929\u6570"}</span><Input type="number" min={1} max={3650} value={localSettings.log_retention_days} onChange={(event) => setLocalSettings((current) => ({ ...current, log_retention_days: Number(event.target.value) || 30 }))} /></label><p className="mt-2 text-xs text-muted">{"\u4e0b\u6b21\u542f\u52a8\u65f6\u6309\u6b64\u5929\u6570\u6e05\u7406\u65e7\u65e5\u5fd7\u3002"}</p><div className="mt-4 flex flex-wrap gap-2"><Button variant="outline" onClick={() => setLocalSettings((current) => ({ ...current, log_retention_days: localDefaults.log_retention_days }))}><RotateCcw />{"\u6062\u590d\u9ed8\u8ba4"}</Button><Button variant="outline" onClick={() => void openLocalFolder("logs")}><FolderOpen />{"\u6253\u5f00\u65e5\u5fd7"}</Button><Button variant="outline" onClick={() => void openLocalFolder("data")}><FolderOpen />{"\u6253\u5f00\u6570\u636e"}</Button></div></SettingsCard>}

        {section === "about" && <SettingsCard title="dean-nai"><p className="text-sm leading-relaxed text-muted">面向 Windows 的本地 NovelAI 工作台，将生图、提示词资料库、可选外置资料接口、标签词库、本地画廊、在线画廊与统计整合在同一个桌面程序中。</p><p className="mt-3 text-xs text-muted">程序不附带、推荐或授权任何外置资料来源；用户自行配置的内容不会上传到项目仓库。软件依赖许可与致谢见根目录 THIRD_PARTY_NOTICES.md。</p></SettingsCard>}
      </main>
    </div>
  </FeatureShell>;
}
