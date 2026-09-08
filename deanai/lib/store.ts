"use client";

import { create } from "zustand";
import { toast } from "sonner";
import {
  NaiClient,
  normalizeConnection,
  EventType,
  loadConnection,
  saveConnection,
  clearConnection,
  loadSettings,
  saveSettings,
  loadUIPrefs,
  saveUIPrefs,
  verifyToken,
  fetchAccountStatus,
  fetchV5Quota,
  type V5QuotaStatus,
  type AccountStatus,
  type ConnectionConfig,
} from "@/lib/nai/client";
import { composePositivePrompt, DEFAULT_SETTINGS, toMetadata, type GenerationSettings, type ReferenceImage, type CharacterSetting } from "@/lib/nai/types";
import { estimateGenerationCost, isV4Model, isV5Model } from "@/lib/nai/models";
import { automaticDelayMs, automaticPolicyKey, automaticStopReason, type AutomaticRun } from "@/lib/automatic-generation";
import { Host, type EmotionOptions, type Image } from "nekoai-js";
import { loadAppPreferences, renderFilename } from "@/lib/app-preferences";
import { saveDataUrl } from "@/lib/image-actions";
import { reportClientEvent } from "@/lib/client-log";
import { initializeGenerationLedger, recordGeneratedImages } from "@/lib/generation-counter";
import { drawRandomLibraryEntry } from "@/lib/random-library";
import {
  ACTIVE_GALLERY_LIMIT,
  clearActiveImages,
  loadImages,
  saveImage,
  moveImageToTrash,
  type GalleryImage,
} from "@/lib/db/gallery";

export type SettingsTab = "basic" | "advanced" | "characters";

type RestoreSettingsOptions = {
  message?: string;
  /** A stable id lets rapid gallery browsing update one Undo toast instead of stacking many. */
  toastId?: string;
};

const CONNECTION_SESSION_KEY = "dean-nai-connection-session-v1";
const CONNECTION_DAILY_KEY = "dean-nai-connection-daily-v1";
type ConnectionSession = {
  tokenKey: string;
  accountStatus: AccountStatus | null;
  anlasBalance: number | null;
  v5Quota?: V5QuotaStatus | null;
};
type ConnectionDaily = ConnectionSession & { verifiedOn: string };

function connectionTokenKey(cfg: ConnectionConfig) {
  return `${cfg.host}:${cfg.token.length}:${cfg.token.slice(-12)}`;
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadConnectionSession(cfg: ConnectionConfig): ConnectionSession | null {
  try {
    const cached = JSON.parse(sessionStorage.getItem(CONNECTION_SESSION_KEY) || "null") as ConnectionSession | null;
    return cached?.tokenKey === connectionTokenKey(cfg) ? cached : null;
  } catch {
    return null;
  }
}

function loadConnectionDaily(cfg: ConnectionConfig): ConnectionDaily | null {
  try {
    const cached = JSON.parse(localStorage.getItem(CONNECTION_DAILY_KEY) || "null") as ConnectionDaily | null;
    return cached?.tokenKey === connectionTokenKey(cfg) && cached.verifiedOn === localDateKey() ? cached : null;
  } catch {
    return null;
  }
}

function saveConnectionSession(cfg: ConnectionConfig, accountStatus: AccountStatus | null, anlasBalance: number | null, v5Quota: V5QuotaStatus | null = accountStatus) {
  const value = { tokenKey: connectionTokenKey(cfg), accountStatus, anlasBalance, v5Quota } satisfies ConnectionSession;
  try {
    sessionStorage.setItem(CONNECTION_SESSION_KEY, JSON.stringify(value));
  } catch {
    // The app still works when a hardened browser disables sessionStorage.
  }
  try {
    localStorage.setItem(CONNECTION_DAILY_KEY, JSON.stringify({ ...value, verifiedOn: localDateKey() } satisfies ConnectionDaily));
  } catch {
    // Daily verification cache is optional in hardened browsers.
  }
}

function clearConnectionSession() {
  try { sessionStorage.removeItem(CONNECTION_SESSION_KEY); } catch { /* optional cache */ }
  try { localStorage.removeItem(CONNECTION_DAILY_KEY); } catch { /* optional cache */ }
}

/** Emit a streaming preview every N diffusion steps instead of every step. toDataURL() on a
 * full-resolution canvas plus a grid-wide re-render per step is the dominant CPU cost during
 * generation; at 28 steps this reduces intermediate frames from 28 to ~9 per sample. */
const PREVIEW_THROTTLE = 3;

/** Longest side (px) of the downscaled streaming preview. The browser has to decode + blur every
 * intermediate frame it shows; at 832x1216 that is the dominant CPU cost during generation. A
 * ~256px thumbnail makes each frame ~30x cheaper to decode and blur, while staying legible enough
 * to judge composition and abort early. The FINAL image is never downscaled. */
const PREVIEW_MAX = 256;

function generatedFilename(settings: GenerationSettings, batchId: number, index: number): string {
  return renderFilename(loadAppPreferences().filenameTemplate, {
    artistName: settings.artistPromptName,
    sceneName: settings.scenePromptName,
    timestamp: batchId,
    index,
  });
}

let lastGenerationStartedAt = 0;
let initializationStarted = false;
let gachaAutoTimer: number | null = null;
let generationBusy = false;
let lastAccountRefreshAt = 0;
let lastV5RefreshAt = 0;
let gachaEpoch = 0;
let gachaExpectedSettings: GenerationSettings | null = null;

function clearGachaAutoTimer() {
  if (gachaAutoTimer !== null && typeof window !== "undefined") window.clearTimeout(gachaAutoTimer);
  gachaAutoTimer = null;
}

/**
 * Decode a raw PNG/JPEG frame and re-encode it as a small data-URL for the streaming grid.
 * createImageBitmap decodes off the main thread (native), the scaled draw is cheap, and the
 * resulting thumbnail is far cheaper for the browser to render than the full-resolution frame.
 * Falls back to the full-res data-URL when createImageBitmap is unavailable or fails.
 */
async function downscalePreview(image: { data: Uint8Array; toDataURL: () => string }): Promise<string> {
  try {
    if (typeof createImageBitmap === "undefined") return image.toDataURL();
    const blob = new Blob([image.data as BlobPart], { type: "image/png" });
    const bmp = await createImageBitmap(blob);
    try {
      const scale = Math.min(1, PREVIEW_MAX / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return image.toDataURL();
      ctx.drawImage(bmp, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.7);
    } finally {
      bmp.close();
    }
  } catch {
    return image.toDataURL();
  }
}

export type StreamTile = {
  sampleIndex: number;
  dataUrl: string | null;
  stepIndex: number;
  progress: number; // 0..1
  status: "initializing" | "generating" | "done";
};

type ReferenceField = "vibe" | "directorReference";

export type DirectorKind =
  | "lineArt"
  | "sketch"
  | "backgroundRemoval"
  | "declutter"
  | "colorize"
  | "emotion"
  | "upscale"
  | "enhance";

export type DirectorOpts = { prompt?: string; defry?: number; emotion?: EmotionOptions; level?: number };

type Store = {
  // ---- connection ----
  connection: ConnectionConfig | null;
  client: NaiClient | null;
  /** Resolves false when the token was hard-rejected; the modal stays open and explains. */
  connect: (cfg: ConnectionConfig) => Promise<boolean>;
  connectionStatus: "idle" | "verifying" | "ok" | "invalid";
  anlasBalance: number | null;
  accountStatus: AccountStatus | null;
  accountError: string | null;
  accountRefreshing: boolean;
  refreshAnlas: () => Promise<void>;
  v5Quota: V5QuotaStatus | null;
  v5QuotaError: string | null;
  v5QuotaRefreshing: boolean;
  refreshV5Quota: () => Promise<void>;
  disconnect: () => void;

  // ---- settings ----
  settings: GenerationSettings;
  patchSettings: (patch: Partial<GenerationSettings>) => void;
  resetSettings: () => void;
  restoreSettings: (s: GenerationSettings, options?: RestoreSettingsOptions) => void;
  addCharacter: () => void;
  updateCharacter: (i: number, patch: Partial<CharacterSetting>) => void;
  removeCharacter: (i: number) => void;
  addReference: (field: ReferenceField, ref: ReferenceImage) => void;
  updateReference: (field: ReferenceField, i: number, patch: Partial<ReferenceImage>) => void;
  removeReference: (field: ReferenceField, i: number) => void;

  // ---- gallery ----
  images: GalleryImage[];
  /** Distinguishes first-paint, genuinely empty, and IDB-unavailable — they used to render alike. */
  galleryStatus: "loading" | "ready" | "error";
  galleryError: string | null;
  selectedBatch: GalleryImage[] | null;
  selectedImage: GalleryImage | null;
  loadGallery: () => Promise<void>;
  selectBatch: (batchId: number, loadRecipe?: boolean) => void;
  selectImage: (img: GalleryImage, loadRecipe?: boolean) => void;
  deleteImage: (id: number) => Promise<void>;
  clearGallery: () => Promise<void>;

  // ---- generation ----
  isGenerating: boolean;
  streamingBatch: StreamTile[] | null;
  /** Last failure, kept so the canvas can explain it after the toast fades. */
  lastError: { message: string; at: number } | null;
  abortRequested: boolean;
  /** False for V3, whose final-only request cannot be interrupted through nekoai-js. */
  canCancelGeneration: boolean;
  /** Wall-clock start of the current run, so waits can show elapsed time instead of a frozen ring. */
  runStartedAt: number | null;
  generate: (source?: "manual" | "gacha-auto") => Promise<void>;
  /** Internal entry; callers must use generate() to acquire the request lock. */
  generateOnce: (source: "manual" | "gacha-auto") => Promise<void>;
  cancelGenerate: () => void;
  gachaMode: boolean;
  automaticRun: AutomaticRun | null;
  automaticStopMessage: string | null;
  stopAutomatic: (reason: string) => void;
  setGachaMode: (enabled: boolean) => void;
  clearError: () => void;

  // ---- director tools ----
  isDirectorProcessing: boolean;
  directorKind: DirectorKind | null;
  runDirector: (kind: DirectorKind, opts?: DirectorOpts) => Promise<void>;

  // ---- ui ----
  settingsCollapsed: boolean;
  activeTab: SettingsTab;
  galleryOpen: boolean;
  showConnect: boolean;
  showDirector: boolean;
  focusedIndex: number | null;
  setUI: (
    patch: Partial<
      Pick<
        Store,
        "settingsCollapsed" | "activeTab" | "galleryOpen" | "showConnect" | "showDirector" | "focusedIndex"
      >
    >,
  ) => void;

  // ---- lifecycle ----
  init: () => Promise<void>;
};

export const useStore = create<Store>()((set, get) => ({
  // ---- connection ----
  connection: null,
  client: null,
  connectionStatus: "idle",
  anlasBalance: null,
  accountStatus: null,
  accountError: null,
  accountRefreshing: false,
  v5Quota: null,
  v5QuotaError: null,
  v5QuotaRefreshing: false,
  refreshV5Quota: async () => {
    const cfg = get().connection;
    if (!cfg) { set({ v5Quota: null, v5QuotaError: null }); return; }
    if (get().v5QuotaRefreshing || Date.now() - lastV5RefreshAt < 5000) return;
    lastV5RefreshAt = Date.now();
    set({ v5QuotaRefreshing: true, v5QuotaError: null });
    try {
      const v5Quota = await fetchV5Quota(cfg);
      if (get().connection !== cfg) return;
      set({ v5Quota });
      saveConnectionSession(cfg, get().accountStatus, get().anlasBalance, v5Quota);
    } catch (error) {
      if (get().connection === cfg) set({ v5QuotaError: error instanceof Error ? error.message : String(error) });
    } finally {
      if (get().connection === cfg) set({ v5QuotaRefreshing: false });
    }
  },
  refreshAnlas: async () => {
    if (get().accountRefreshing) return;
    const cfg = get().connection;
    if (!cfg) {
      set({ anlasBalance: null, accountStatus: null, accountError: null });
      return;
    }
    if (Date.now() - lastAccountRefreshAt < 5000) return;
    lastAccountRefreshAt = Date.now();
    set({ accountRefreshing: true, accountError: null });
    try {
      const accountStatus = await fetchAccountStatus(cfg);
      if (get().connection !== cfg) return;
      const anlasBalance = accountStatus?.anlasBalance ?? null;
      set({
        accountStatus,
        anlasBalance,
        accountError: accountStatus || cfg.host !== Host.WEB ? null : "无法读取订阅信息",
      });
      saveConnectionSession(cfg, accountStatus, anlasBalance, get().v5Quota);
    } catch (error) {
      if (get().connection !== cfg) return;
      set({
        accountError: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (get().connection === cfg) set({ accountRefreshing: false });
    }
  },
  connect: async (cfg) => {
    cfg = normalizeConnection(cfg);
    lastAccountRefreshAt = 0;
    lastV5RefreshAt = 0;
    set({ connection: null, client: null, anlasBalance: null, accountStatus: null, accountRefreshing: false, v5Quota: null, v5QuotaError: null, v5QuotaRefreshing: false });
    set({ connectionStatus: "verifying", accountError: null });
    const verificationStartedAt = Date.now();
    const verdict = await verifyToken(cfg);
    reportClientEvent("token-verification", `result=${verdict} duration_ms=${Date.now() - verificationStartedAt}`);
    if (verdict === "invalid") {
      clearConnectionSession();
      set({
        connectionStatus: "invalid",
        accountError: "NovelAI 明确返回 401：这个 Token 无效。",
        showConnect: true,
      });
      return false;
    }
    saveConnection(cfg);
    set({
      connection: cfg,
      client: new NaiClient(cfg),
      showConnect: false,
      connectionStatus: "ok",
      accountError: verdict === "unknown"
        ? "Token 已保存；订阅接口暂时无法验证。实际生图成功时不应据此判定 Token 无效。"
        : null,
    });
    saveConnectionSession(cfg, null, null);
    await Promise.all([get().refreshAnlas(), get().refreshV5Quota()]);
    return true;
  },
  disconnect: () => {
    get().stopAutomatic("账户已断开连接");
    clearConnection();
    clearConnectionSession();
    lastAccountRefreshAt = 0;
    lastV5RefreshAt = 0;
    set({ connection: null, client: null, connectionStatus: "idle", anlasBalance: null, accountStatus: null, accountError: null, accountRefreshing: false, v5Quota: null, v5QuotaError: null, v5QuotaRefreshing: false, gachaMode: false });
  },

  // ---- settings ----
  settings: DEFAULT_SETTINGS,
  patchSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  resetSettings: () => set({ settings: DEFAULT_SETTINGS }),
  restoreSettings: (snapshot, options) => {
    // This replaces the prompt, the negative prompt, every character and every uploaded reference.
    // Its call sites are ~28px glyphs on hover overlays sitting one gap away from "copy seed" —
    // same visual weight, wildly different blast radius — so it needs the same undo affordance
    // deleteImage already has.
    const prev = get().settings;
    const hadWork =
      composePositivePrompt(prev) !== "" ||
      prev.negativePrompt.trim() !== "" ||
      prev.characters.length > 0 ||
      prev.vibe.length > 0 ||
      prev.directorReference.length > 0;

    set({ settings: { ...DEFAULT_SETTINGS, ...snapshot } });
    toast.success(options?.message ?? `Restored — seed ${snapshot.seed}, ${snapshot.steps} steps`, {
      id: options?.toastId,
      // Only offered when something was actually overwritten. On a fresh form — the common case
      // while browsing the gallery — restoring is harmless, and an Undo there is noise that
      // teaches people to ignore it.
      ...(hadWork
        ? { duration: 6000, action: { label: "Undo", onClick: () => set({ settings: prev }) } }
        : {}),
    });
  },
  addCharacter: () =>
    set((s) => ({
      settings: {
        ...s.settings,
        characters: [
          ...s.settings.characters,
          { prompt: "", uc: "", center: { x: 0.5, y: 0.5 }, enabled: true },
        ],
      },
    })),
  updateCharacter: (i, patch) =>
    set((s) => ({
      settings: {
        ...s.settings,
        characters: s.settings.characters.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
      },
    })),
  removeCharacter: (i) =>
    set((s) => ({
      settings: { ...s.settings, characters: s.settings.characters.filter((_, idx) => idx !== i) },
    })),
  addReference: (field, ref) =>
    set((s) => ({ settings: { ...s.settings, [field]: [...s.settings[field], ref] } })),
  updateReference: (field, i, patch) =>
    set((s) => ({
      settings: {
        ...s.settings,
        [field]: s.settings[field].map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
      },
    })),
  removeReference: (field, i) =>
    set((s) => ({
      settings: { ...s.settings, [field]: s.settings[field].filter((_, idx) => idx !== i) },
    })),

  // ---- gallery ----
  images: [],
  galleryStatus: "loading",
  galleryError: null,
  selectedBatch: null,
  selectedImage: null,
  loadGallery: async () => {
    set({ galleryStatus: "loading", galleryError: null });
    try {
      const images = await loadImages();
      if (images.length) initializeGenerationLedger(images.length, images.map((image) => ({ id: image.id, timestamp: image.timestamp, filename: image.filename })));
      set({ images, galleryStatus: "ready" });
      if (images.length > 0) get().selectBatch(images[0].batchId);
    } catch (e) {
      // Swallowing this used to leave images: [], telling a returning user whose storage failed
      // that they had never generated anything.
      console.error("Failed to load gallery", e);
      set({ galleryStatus: "error", galleryError: e instanceof Error ? e.message : String(e) });
    }
  },
  selectBatch: (batchId, loadRecipe = false) => {
    const { images } = get();
    const batch = images.filter((i) => i.batchId === batchId).sort((a, b) => a.batchIndex - b.batchIndex);
    if (batch.length) {
      set({ selectedBatch: batch, selectedImage: batch[0], focusedIndex: null });
      if (loadRecipe) {
        get().restoreSettings(batch[0].settings, {
          message: `Recipe loaded from gallery — seed ${batch[0].seed}`,
          toastId: "recipe-loaded",
        });
      }
    }
  },
  selectImage: (img, loadRecipe = false) => {
    set({ selectedImage: img });
    if (loadRecipe) {
      get().restoreSettings(img.settings, {
        message: `Recipe loaded from gallery — seed ${img.seed}`,
        toastId: "recipe-loaded",
      });
    }
  },
  deleteImage: async (id) => {
    const doomed = get().images.find((image) => image.id === id);
    if (!doomed) return;

    const prevImages = get().images;
    const prevBatch = get().selectedBatch;
    const prevSelected = get().selectedImage;
    const images = prevImages.filter((image) => image.id !== id);
    set({ images });
    if (prevBatch) {
      const batch = prevBatch.filter((image) => image.id !== id);
      if (batch.length) {
        const stillThere = prevSelected && batch.some((image) => image.id === prevSelected.id);
        const deletedAt = prevBatch.findIndex((image) => image.id === id);
        const next = stillThere ? prevSelected : batch[Math.min(Math.max(deletedAt, 0), batch.length - 1)];
        set({ selectedBatch: batch, selectedImage: next });
      } else if (images.length) get().selectBatch(images[0].batchId);
      else set({ selectedBatch: null, selectedImage: null });
    }

    try {
      await moveImageToTrash(id);
      toast.success("已移入内部回收站");
    } catch (error) {
      set({ images: prevImages, selectedBatch: prevBatch, selectedImage: prevSelected });
      toast.error(`无法移入回收站：${error instanceof Error ? error.message : String(error)}`);
    }
  },
  clearGallery: async () => {
    const count = get().images.length;
    try {
      await clearActiveImages();
      set({ images: [], selectedBatch: null, selectedImage: null });
      toast.success("已永久删除 " + count + " 张生图历史");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to clear gallery", error);
      set({ galleryStatus: "error", galleryError: message });
      toast.error("无法删除生图历史：" + message);
    }
  },  // ---- generation ----
  isGenerating: false,
  streamingBatch: null,
  lastError: null,
  abortRequested: false,
  canCancelGeneration: false,
  runStartedAt: null,
  gachaMode: false,
  automaticRun: null,
  automaticStopMessage: null,
  stopAutomatic: (reason) => {
    clearGachaAutoTimer();
    gachaEpoch++;
    gachaExpectedSettings = null;
    set((s) => ({ gachaMode: false, automaticStopMessage: reason, automaticRun: s.automaticRun ? { ...s.automaticRun, nextAt: null } : null }));
  },
  setGachaMode: (enabled) => {
    if (!enabled) { get().stopAutomatic("已手动停止；已提交的图片仍会保存"); return; }
    if (generationBusy || get().isDirectorProcessing) { toast.info("请等当前任务结束后再开启抽卡模式"); return; }
    clearGachaAutoTimer();
    gachaEpoch++;
    set({ gachaMode: true, automaticRun: null, automaticStopMessage: null });
  },
  cancelGenerate: () => {
    const { isGenerating, canCancelGeneration } = get();
    get().stopAutomatic("已手动停止");
    if (!isGenerating) return;
    if (!canCancelGeneration) {
      toast.info("V3 generations return only a final image and can't be stopped once submitted.");
      return;
    }
    set({ abortRequested: true });
  },
  clearError: () => set({ lastError: null }),
  generate: async (source = "manual") => {
    if (generationBusy || get().isGenerating || get().isDirectorProcessing) return;
    if (source === "gacha-auto" && (!get().gachaMode || !get().automaticRun)) return;
    if (source === "manual" && get().automaticRun && get().gachaMode) {
      toast.info("自动任务运行中，请先停止自动模式再手动生成"); return;
    }
    generationBusy = true;
    try {
      if (typeof navigator !== "undefined" && navigator.locks) {
        await navigator.locks.request("dean-nai-generation", { ifAvailable: true }, async (lock) => {
          if (!lock) { get().stopAutomatic("同一浏览器的另一页面正在生成"); toast.info("另一页面正在生成，请等待完成"); return; }
          await get().generateOnce(source);
        });
      } else {
        await get().generateOnce(source);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      get().stopAutomatic(message);
      toast.error(`任务已停止：${message}`);
    } finally {
      generationBusy = false;
    }
  },
  generateOnce: async (source) => {
    const stopAutomaticRun = (reason = "本次生成未提交") => { if (get().gachaMode) get().stopAutomatic(reason); };
    const { client, connection } = get();
    const preferences = loadAppPreferences();
    const automatic = get().gachaMode && preferences.gachaAutoGenerate;
    if (source === "gacha-auto" && !automatic) { stopAutomaticRun("自动继续已关闭"); return; }
    const epoch = gachaEpoch;
    const originalSettings = get().settings;
    const settings = automatic ? { ...originalSettings, nSamples: 1 } : originalSettings;
    const stillCurrent = () => get().gachaMode && gachaEpoch === epoch && get().connection === connection;
    if (!client) {
      stopAutomaticRun();
      set({ showConnect: true });
      return;
    }
    // An empty prompt is a real, billed request that returns noise. Characters count as intent —
    // a V4 prompt can legitimately live entirely in the character list.
    const hasIntent =
      composePositivePrompt(settings).length > 0 ||
      settings.characters.some((c) => c.enabled && c.prompt.trim().length > 0);
    if (!hasIntent) {
      stopAutomaticRun();
      toast.error("Describe something first — an empty prompt still costs Anlas.");
      set({ settingsCollapsed: false, activeTab: "basic" });
      return;
    }
    if (automatic) {
      let run = get().automaticRun;
      if (run && (automaticPolicyKey(run.policy) !== automaticPolicyKey(preferences) || gachaExpectedSettings !== originalSettings)) {
        stopAutomaticRun("设置或提示词已更改，请手动重新开始"); return;
      }
      if (!run) {
        run = { id: epoch, startedAt: Date.now(), generated: 0, estimatedSpent: 0, nextAt: null, policy: preferences };
        set({ automaticRun: run, automaticStopMessage: null });
      }
      const reason = automaticStopReason(run, Date.now());
      if (reason) { stopAutomaticRun(reason); return; }
      if (!navigator.onLine || (preferences.gachaStopWhenHidden && document.hidden)) {
        stopAutomaticRun("已离线或程序进入后台，请手动重新开始"); return;
      }
      // Fresh account data is required; the manual Opus assumption must never authorize an automatic purchase.
      if (!connection || connection.host !== Host.WEB) { stopAutomaticRun("当前连接不支持账户额度校验，请使用手动生成"); return; }
      const fresh = await fetchAccountStatus(connection);
      if (!stillCurrent()) return;
      if (get().settings !== originalSettings || automaticPolicyKey(loadAppPreferences()) !== automaticPolicyKey(preferences)) {
        stopAutomaticRun("等待期间设置已更改，请手动重新开始"); return;
      }
      if (!fresh) { stopAutomaticRun("无法读取最新账户额度，未提交生成请求"); return; }
      set({ accountStatus: fresh, anlasBalance: fresh.anlasBalance, accountError: null, v5Quota: fresh, v5QuotaError: null });
      saveConnectionSession(connection, fresh, fresh.anlasBalance);
      if (!fresh.active) { stopAutomaticRun("订阅已失效，请确认账户状态"); return; }
      if (isV5Model(settings.model) && fresh.tier === 3 && (!fresh.opusUsage || fresh.opusUsage.isNegative || fresh.opusUsage.percent <= 0)) {
        stopAutomaticRun("V5 免费额度耗尽或未知；不会自动转为付费继续"); return;
      }
      set({ automaticRun: { ...run, nextAt: null } });
    }
    const generationClient = automatic && connection
      ? new NaiClient({ ...connection, maxRetries: 0 })
      : client;
    const now = Date.now();
    const intervalMs = preferences.generationIntervalSeconds * 1000;
    const remainingMs = lastGenerationStartedAt + intervalMs - now;
    if (remainingMs > 0) {
      stopAutomaticRun();
      toast.info(`生成间隔保护：请再等待 ${Math.ceil(remainingMs / 1000)} 秒。`);
      return;
    }
    const account = get().accountStatus;
    const isOpus = Boolean(account?.active && account.tier === 3) || (!automatic && preferences.assumeOpusFreeImages);
    const estimatedCost = estimateGenerationCost(settings, isOpus, Boolean(account?.opusUsage?.isNegative));
    if (automatic) {
      const run = get().automaticRun!;
      const reason = automaticStopReason(run, now, estimatedCost);
      if (reason) { stopAutomaticRun(reason); return; }
      if (!account || estimatedCost > account.anlasBalance) { stopAutomaticRun("可用 Anlas 不足"); return; }
    }
    const continuingGacha = source === "gacha-auto";
    if (
      preferences.warnHighCost &&
      estimatedCost >= preferences.highCostThreshold &&
      !continuingGacha
    ) {
      const approved = window.confirm(
        `预计本次消耗约 ${estimatedCost} Anlas，已达到警告阈值 ${preferences.highCostThreshold}。\n\n仍然生成吗？`,
      );
      if (!approved) {
        stopAutomaticRun();
        return;
      }
    }
    if (automatic) {
      if (!stillCurrent()) return;
      const run = get().automaticRun!;
      const reason = automaticStopReason(run, Date.now(), estimatedCost);
      if (reason) { stopAutomaticRun(reason); return; }
      set({ automaticRun: { ...run, estimatedSpent: run.estimatedSpent + estimatedCost } });
    }
    lastGenerationStartedAt = Date.now();
    const n = Math.max(1, settings.nSamples);
    const canCancelGeneration = isV4Model(settings.model);
    const compactLayout = typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches;
    // Deliberately does NOT clear selectedBatch/selectedImage: the success path below overwrites
    // them anyway, and keeping them means a failed run leaves the user's previous image intact
    // instead of dumping them on the first-run empty state.
    set({
      isGenerating: true,
      lastError: null,
      abortRequested: false,
      canCancelGeneration,
      runStartedAt: Date.now(),
      // On compact layouts the composer is a drawer over the canvas. Committing the prompt should
      // reveal streaming immediately; the persistent desktop composer stays exactly where it is.
      ...(compactLayout ? { settingsCollapsed: true } : {}),
      streamingBatch: Array.from({ length: n }, (_, i) => ({
        sampleIndex: i,
        dataUrl: null,
        stepIndex: 0,
        progress: 0,
        status: "initializing" as const,
      })),
    });

    // Declared outside the try so the catch can still reach them: a run that dies mid-stream has
    // to be able to persist the samples that already finished.
    const finals: { dataUrl: string; sampleIndex: number }[] = [];
    const batchId = Date.now();
    const generationStartedAt = Date.now();
    let baseSeed = 0;
    let failureMessage: string | null = null;
    let autoSaveFailed = false;
    let commitAttempted = false;
    let committed: GalleryImage[] = [];
    reportClientEvent(
      "generation-start",
      `model=${settings.model} size=${settings.width}x${settings.height} steps=${settings.steps} samples=${n} estimated_anlas=${estimatedCost}`,
    );

    // Persist whatever finished and reveal it. Called from both the success tail and the catch.
    const commit = async (): Promise<GalleryImage[]> => {
      if (commitAttempted) return committed;
      commitAttempted = true;
      if (!finals.length) return [];
      const ordered = finals.slice().sort((a, b) => a.sampleIndex - b.sampleIndex);
      const saved = await Promise.all(
        ordered.map(async (f, i) => {
          // Per-image seed, not the batch base seed — otherwise "Use these settings" on image #3
          // silently restores image #1's recipe while the toolbar chip shows the correct seed.
          const img: GalleryImage = {
            dataUrl: f.dataUrl,
            timestamp: new Date().toISOString(),
            filename: generatedFilename(settings, batchId, i + 1),
            seed: baseSeed + f.sampleIndex,
            settings: { ...settings, seed: baseSeed + f.sampleIndex },
            batchId,
            batchIndex: i,
            batchSize: ordered.length,
          };
          img.id = await saveImage(img);
          return img;
        }),
      );
      committed = saved;

      recordGeneratedImages(saved.map((image) => ({ id: image.id, timestamp: image.timestamp, filename: image.filename })));
      set((s) => ({ images: [...saved.slice().reverse(), ...s.images].slice(0, ACTIVE_GALLERY_LIMIT) }));
      // The gallery is an overlay below 1280px. Opening it here would cover the result at the exact
      // moment it resolves; on wide layouts it remains a useful persistent confirmation/history.
      const compact = typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches;
      set({ selectedBatch: saved, selectedImage: saved[0], galleryOpen: !compact });
      if (preferences.autoSave) {
        const results = await Promise.allSettled(
          saved.map((image) =>
            saveDataUrl(image.dataUrl, image.filename, { automatic: true, quiet: true, retentionIdentity: image }),
          ),
        );
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length) {
          autoSaveFailed = true;
          toast.error(
            `自动保存完成 ${saved.length - failures.length}/${saved.length}；请检查保存目录和当天日志。`,
          );
        } else {
          reportClientEvent("auto-save", `saved=${saved.length}`);
        }
      }
      return saved;
    };

    let succeeded = false;
    try {
      const { seed, streaming, events } = await generationClient.generate(settings);
      baseSeed = seed;

      // Pre-allocate a mutable array so we can update tiles by index instead of mapping
      // the entire array on every event. For V4/V4.5, 28 steps × 4 samples = 112
      // intermediate events — mapping the full array each time is measurable overhead.
      let batchArray = get().streamingBatch;

      for await (const ev of events) {
        // Breaking calls the iterator's .return(), which closes the stream reader. nekoai-js's own
        // AbortControllers are internal and timeout-only, so this is the available cancel path.
        if (streaming && get().abortRequested) break;
        if (ev.event_type === EventType.INTERMEDIATE) {
          // CPU hotspot: for V4/V4.5 this fires 28 times per sample. Every call to
          // toDataURL() base64-encodes the full-resolution canvas and every set() re-renders
          // the whole streaming grid. Throttle the preview to every N steps so a 4-sample run
          // drops from ~112 to ~28 expensive frames, while still always showing the last
          // intermediate so the tile never looks stale right before the FINAL resolves.
          const isLastStep = ev.step_ix >= settings.steps - 1;
          if (ev.step_ix % PREVIEW_THROTTLE !== 0 && !isLastStep) continue;
          // Downscale to a ~256px thumbnail: the browser has to decode + blur every frame it
          // shows, and a full 832x1216 intermediate is the dominant CPU cost during generation.
          const dataUrl = await downscalePreview(ev.image);
          // Mutate the local reference, then push a single shallow copy into state.
          // This avoids traversing all N tiles on every intermediate step.
          if (batchArray) {
            const idx = batchArray.findIndex((t) => t.sampleIndex === ev.samp_ix);
            if (idx !== -1) {
              batchArray = batchArray.with(idx, {
                ...batchArray[idx],
                dataUrl,
                stepIndex: ev.step_ix,
                progress: Math.min(1, ev.step_ix / settings.steps),
                status: "generating" as const,
              });
              set({ streamingBatch: batchArray });
            }
          }
        } else if (ev.event_type === EventType.FINAL) {
          // The tile must adopt the FINAL image, not keep the last INTERMEDIATE. Previously the
          // frame that un-blurred on completion was the penultimate latent — legible only
          // *because* it was blurred — which then swapped to a different image once the batch
          // committed. And a stream that emits no intermediates at all left dataUrl null while
          // status flipped to "done", stranding the tile on a shimmer that never resolved.
          const dataUrl = ev.image.toDataURL();
          finals.push({ dataUrl, sampleIndex: ev.samp_ix });
          if (batchArray) {
            const idx = batchArray.findIndex((t) => t.sampleIndex === ev.samp_ix);
            if (idx !== -1) {
              batchArray = batchArray.with(idx, {
                ...batchArray[idx],
                dataUrl,
                progress: 1,
                status: "done" as const,
              });
              set({ streamingBatch: batchArray });
            }
          }
        }
      }

      const saved = await commit();
      succeeded = saved.length === n && !get().abortRequested && !autoSaveFailed;

      if (get().abortRequested) {
        toast(saved.length ? `Stopped — kept ${saved.length} finished image${saved.length > 1 ? "s" : ""}` : "Stopped");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failureMessage = message;
      stopAutomaticRun(`生成失败：${message}`);
      console.error("Generation failed", e);

      // Samples that already finished are paid for and unreproducible, so a late failure must not
      // discard them — the abort path above already keeps them, and diverging here was the bug.
      // Persisting is best-effort: a save failure must not mask the error that actually broke the run.
      let rescued: GalleryImage[] = [];
      try {
        rescued = await commit();
      } catch (saveErr) {
        console.error("Could not persist images from the failed run", saveErr);
      }

      if (rescued.length) {
        // Not an ErrorState: there are images on screen. A full-canvas error card would cover
        // the very thing that survived.
        toast.error(`Run failed — kept ${rescued.length} finished image${rescued.length > 1 ? "s" : ""}`);
      } else {
        set({ lastError: { message, at: Date.now() } });
        toast.error(`Generation failed: ${message}`);
      }
    } finally {
      const finalState = get().abortRequested ? "cancelled" : failureMessage ? "failed" : succeeded ? "succeeded" : "empty";
      reportClientEvent(
        "generation-finish",
        `status=${finalState} completed=${finals.length}/${n} duration_ms=${Date.now() - generationStartedAt}${failureMessage ? ` error=${failureMessage.slice(0, 500)}` : ""}`,
      );
      set({
        isGenerating: false,
        streamingBatch: null,
        abortRequested: false,
        canCancelGeneration: false,
        runStartedAt: null,
      });
      if (automatic && get().automaticRun?.id === epoch) {
        set({ automaticRun: { ...get().automaticRun!, generated: get().automaticRun!.generated + finals.length } });
      }
      if (!automatic || !stillCurrent()) {
        void get().refreshAnlas();
        if (isV5Model(settings.model)) void get().refreshV5Quota();
      }
      if (!succeeded && stillCurrent()) {
        stopAutomaticRun(autoSaveFailed ? "自动保存失败，请检查保存目录" : "生成被取消或未完整返回图片");
      }
      if (succeeded && stillCurrent()) {
        try {
          if (automatic) {
            const run = get().automaticRun!;
            const fresh = connection ? await fetchAccountStatus(connection) : null;
            if (!stillCurrent()) return;
            if (!fresh) throw new Error("生成后无法刷新额度，已停止继续生成");
            set({ accountStatus: fresh, anlasBalance: fresh.anlasBalance, accountError: null, v5Quota: fresh, v5QuotaError: null });
            if (isV5Model(settings.model) && fresh.tier === 3 && (!fresh.opusUsage || fresh.opusUsage.isNegative || fresh.opusUsage.percent <= 0)) throw new Error("V5 免费额度耗尽或未知；已停止自动继续");
            if (estimatedCost === 0 && account && fresh.anlasBalance < account.anlasBalance) throw new Error("检测到预计免费生成仍扣除了 Anlas，请检查官方计费");
            const reason = automaticStopReason(run, Date.now());
            if (reason) { stopAutomaticRun(reason); return; }
          }
          if (get().settings !== originalSettings) throw new Error("生成期间提示词或参数已修改，请手动重新开始");
          const patch: Partial<GenerationSettings> = {};
          if (preferences.gachaRandomScene) {
            const entry = await drawRandomLibraryEntry("prompt");
            if (!entry.content?.trim()) throw new Error("场景资料库为空或无法读取");
            patch.scenePrompt = entry.content.trim(); patch.scenePromptName = entry.title || "随机场景";
          }
          if (preferences.gachaRandomArtist) {
            const entry = await drawRandomLibraryEntry("artist");
            if (!entry.content?.trim()) throw new Error("画师资料库为空或无法读取");
            patch.artistPrompt = entry.content.trim(); patch.artistPromptName = entry.title || "随机画师串";
          }
          if (!stillCurrent()) return;
          if (get().settings !== originalSettings) throw new Error("随机抽取期间提示词已修改，请手动重新开始");
          set({ settings: { ...originalSettings, ...patch } });
          gachaExpectedSettings = get().settings;
          const nextPreferences = loadAppPreferences();
          if (automatic && nextPreferences.gachaAutoGenerate) {
            if (automaticPolicyKey(preferences) !== automaticPolicyKey(nextPreferences)) throw new Error("自动生成设置已修改，请手动重新开始");
            const run = get().automaticRun!;
            const nextDelay = automaticDelayMs(run);
            const nextAt = Date.now() + nextDelay;
            const deadline = run.startedAt + run.policy.gachaMaxMinutes * 60_000;
            set({ automaticRun: { ...run, nextAt } });
            clearGachaAutoTimer();
            gachaAutoTimer = window.setTimeout(() => {
              gachaAutoTimer = null;
              if (!stillCurrent()) return;
              if (Date.now() >= deadline) { stopAutomaticRun("已达到本轮运行时长上限"); return; }
              if (Date.now() - nextAt > 30_000 || Date.now() < nextAt - 1000) { stopAutomaticRun("计时异常或设备休眠，未自动补发请求"); return; }
              void get().generate("gacha-auto");
            }, Math.max(0, Math.min(nextDelay, deadline - Date.now())));
          }
        } catch (error) {
          if (stillCurrent()) {
            const reason = error instanceof Error ? error.message : String(error);
            stopAutomaticRun(reason);
            toast.error(`抽卡模式已停止：${reason}`);
          }
        }
      }
    }
  },

  // ---- director tools ----
  isDirectorProcessing: false,
  directorKind: null,
  runDirector: async (kind, opts) => {
    if (generationBusy || get().isGenerating || get().isDirectorProcessing) return;
    if (get().gachaMode) get().stopAutomatic("已切换到图片处理工具");
    const { client, selectedImage } = get();
    if (!client) {
      set({ showConnect: true });
      return;
    }
    if (!selectedImage) {
      toast.error("Select an image first");
      return;
    }
    set({ isDirectorProcessing: true, directorKind: kind, lastError: null });
    try {
      const blob = await (await fetch(selectedImage.dataUrl)).blob();
      let results: Image[];
      switch (kind) {
        case "lineArt": results = [await client.lineArt(blob)]; break;
        case "sketch": results = [await client.sketch(blob)]; break;
        case "backgroundRemoval": results = [await client.backgroundRemoval(blob)]; break;
        case "declutter": results = [await client.declutter(blob)]; break;
        case "colorize": results = [await client.colorize(blob, opts?.prompt, opts?.defry)]; break;
        case "emotion": results = [await client.changeEmotion(blob, opts?.emotion, opts?.prompt, opts?.level)]; break;
        case "upscale": results = [await client.upscale(blob, 4)]; break;
        case "enhance": results = await client.enhance(blob); break;
        default: results = [];
      }
      if (!results.length) return;

      const batchId = Date.now();
      const saved: GalleryImage[] = [];
      for (let i = 0; i < results.length; i++) {
        const img: GalleryImage = {
          dataUrl: results[i].toDataURL(),
          timestamp: new Date().toISOString(),
          filename: `deanai_${kind}_${batchId}_${i + 1}.png`,
          seed: selectedImage.seed,
          settings: selectedImage.settings,
          batchId,
          batchIndex: i,
          batchSize: results.length,
          processedWith: kind,
        };
        const id = await saveImage(img);
        img.id = id;
        saved.push(img);
      }
      set((s) => ({
        images: [...saved.slice().reverse(), ...s.images].slice(0, ACTIVE_GALLERY_LIMIT),
        selectedBatch: saved,
        selectedImage: saved[0],
        galleryOpen: !(typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches),
        showDirector: false,
      }));
    } catch (e) {
      console.error("Director tool failed", e);
      toast.error(`Director tool failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      set({ isDirectorProcessing: false, directorKind: null });
    }
  },

  // ---- ui ----
  settingsCollapsed: false,
  activeTab: "basic",
  galleryOpen: false,
  showConnect: false,
  showDirector: false,
  focusedIndex: null,
  setUI: (patch) => set(patch),

  // ---- lifecycle ----
  init: async () => {
    if (initializationStarted) return;
    initializationStarted = true;
    window.addEventListener("dean-nai-preferences-changed", () => {
      const run = get().automaticRun;
      if (run && get().gachaMode && automaticPolicyKey(run.policy) !== automaticPolicyKey(loadAppPreferences())) get().stopAutomatic("自动生成设置已修改，请手动重新开始");
    });
    window.addEventListener("offline", () => { if (get().gachaMode) get().stopAutomatic("网络已断开，请手动重新开始"); });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && get().automaticRun && get().gachaMode && loadAppPreferences().gachaStopWhenHidden) get().stopAutomatic("程序进入后台，已停止自动继续");
    });
    const cfg = loadConnection();
    // The recipe is the one piece of state the user actually authored, and it was the only thing
    // init() didn't restore — so ⌘R wiped it, one key away from the ⌘↵ generate gesture.
    const savedSettings = loadSettings();
    if (savedSettings) set({ settings: savedSettings });
    const savedUI = loadUIPrefs();
    if (savedUI) set(savedUI);

    if (cfg) {
      // sessionStorage avoids duplicate checks during client navigation; localStorage extends the
      // same verified result across restarts, but only for the current local calendar day.
      const cached = loadConnectionSession(cfg) ?? loadConnectionDaily(cfg);
      if (cached) {
        set({
          connection: cfg,
          client: new NaiClient(cfg),
          connectionStatus: "ok",
          accountStatus: cached.accountStatus,
          anlasBalance: cached.anlasBalance,
          v5Quota: "v5Quota" in cached ? cached.v5Quota ?? null : cached.accountStatus,
        });
        // Keep the fast cached first paint, then replace yesterday/earlier-session quota snapshots.
        void get().refreshAnlas();
        void get().refreshV5Quota();
        await get().loadGallery();
        return;
      }
      // Trust the stored token immediately so the app is usable on first paint, then check it in
      // the background. A revoked or expired key otherwise shows "Connected" forever and only
      // reveals itself as a failed generation.
      set({ connection: cfg, client: new NaiClient(cfg), connectionStatus: "verifying" });
      const verdict = await verifyToken(cfg);
      if (verdict === "invalid") {
        clearConnectionSession();
        set({
          client: null,
          connectionStatus: "invalid",
          accountError: "已保存的 NovelAI Token 已失效，请重新填写。",
          showConnect: true,
        });
      } else {
        set({
          connectionStatus: verdict === "ok" ? "ok" : "idle",
          accountError: verdict === "unknown" ? "Token 后台验证暂时失败，可检查网络后重试。" : null,
        });
        saveConnectionSession(cfg, null, null);
        if (verdict === "ok") {
          void get().refreshAnlas();
          void get().refreshV5Quota();
        }
      }
    }
    await get().loadGallery();
  },
}));

// Persist the recipe and the panel layout. Debounced rather than per-keystroke — typing a prompt
// would otherwise serialise the whole settings object on every character.
if (typeof window !== "undefined") {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: GenerationSettings | null = null;
  let lastUI = "";

  useStore.subscribe((s) => {
    const uiKey = `${s.settingsCollapsed}|${s.activeTab}|${s.galleryOpen}`;
    if (s.settings === last && uiKey === lastUI) return;
    last = s.settings;
    lastUI = uiKey;
    clearTimeout(timer);
    timer = setTimeout(() => {
      saveSettings(s.settings);
      saveUIPrefs({
        settingsCollapsed: s.settingsCollapsed,
        activeTab: s.activeTab,
        galleryOpen: s.galleryOpen,
      });
    }, 400);
  });
}
