import {
  NovelAI,
  EventType,
  parseImage,
  Host,
  type Image,
  type ImageInput,
  MsgpackEvent,
  withRetry,
  type EmotionOptions,
} from "nekoai-js";
import { DEFAULT_SETTINGS, type GenerationSettings, toMetadata } from "./types";
import { V5_MAX_CHARACTERS, isV4Model, isV5Model } from "./models";
import { buildV5Prompt, v5QualityTagHint } from "./v5-prompt";
import { parseOpusUsage } from "../account-usage";
import { subscriptionFailure } from "./subscription-error";
import { normalizeNovelAIToken } from "./token";

const IS_STATIC_PWA = process.env.NEXT_PUBLIC_STATIC_PWA === "1";

const subscriptionFlights = new WeakMap<ConnectionConfig, Promise<Response>>();
let subscriptionAccessDenial: Response | null = null;

async function fetchSubscription(cfg: ConnectionConfig): Promise<Response> {
  // A site-level client ban is not a token error. Do not keep hitting it when
  // another panel opens, automatic generation checks, or the account changes.
  if (subscriptionAccessDenial) return subscriptionAccessDenial.clone();
  let pending = subscriptionFlights.get(cfg);
  if (!pending) {
    pending = requestSubscription(cfg).then(async (response) => {
      if (response.status === 403 && (await subscriptionFailure(response.clone(), normalizeNovelAIToken(cfg.token))).blocked) {
        subscriptionAccessDenial = response.clone();
      }
      return response;
    });
    subscriptionFlights.set(cfg, pending);
    const clear = () => { if (subscriptionFlights.get(cfg) === pending) subscriptionFlights.delete(cfg); };
    void pending.then(clear, clear);
  }
  // Each consumer parses its own body; overlapping Anlas/V5 calls share I/O only.
  return (await pending).clone();
}

async function requestSubscription(cfg: ConnectionConfig): Promise<Response> {
  const token = normalizeNovelAIToken(cfg.token);
  if (IS_STATIC_PWA) {
    return fetch("https://image.novelai.net/user/subscription", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
  }
  return fetch("/api/novelai/subscription", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(35000),
  });
}

// ---- Connection config (localStorage; subscription checks use the local server proxy) ----

export type ConnectionConfig = {
  token: string;
  host: string;
  maxRetries: number;
  baseDelay: number;
};

const KEYS = {
  token: "nya-token",
  host: "nya-host",
  maxRetries: "nya-retry-max",
  baseDelay: "nya-retry-base",
} as const;

export const DEFAULT_CONNECTION: Omit<ConnectionConfig, "token"> = {
  host: Host.WEB,
  maxRetries: 3,
  baseDelay: 2000,
};

export function normalizeConnection(cfg: ConnectionConfig): ConnectionConfig {
  return { ...cfg, token: cfg.host === Host.WEB ? normalizeNovelAIToken(cfg.token) : cfg.token.trim() };
}

export function loadConnection(): ConnectionConfig | null {
  if (typeof localStorage === "undefined") return null;
  const token = localStorage.getItem(KEYS.token);
  if (!token) return null;
  return normalizeConnection({
    token,
    host: localStorage.getItem(KEYS.host) || DEFAULT_CONNECTION.host,
    maxRetries: Number(localStorage.getItem(KEYS.maxRetries)) || DEFAULT_CONNECTION.maxRetries,
    baseDelay: Number(localStorage.getItem(KEYS.baseDelay)) || DEFAULT_CONNECTION.baseDelay,
  });
}

export function saveConnection(cfg: ConnectionConfig) {
  cfg = normalizeConnection(cfg);
  localStorage.setItem(KEYS.token, cfg.token);
  localStorage.setItem(KEYS.host, cfg.host);
  localStorage.setItem(KEYS.maxRetries, String(cfg.maxRetries));
  localStorage.setItem(KEYS.baseDelay, String(cfg.baseDelay));
}

export function clearConnection() {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
}

// ---- Settings persistence ----
//
// Deliberately hand-rolled rather than zustand's `persist` middleware: the store is created at
// module scope under SSR, and `persist` rehydrates synchronously at creation, so the server HTML
// (defaults) and the first client render (restored) would disagree. Deferring the read into
// `init()` is the same pattern `loadConnection` already uses.

const SETTINGS_KEY = "nya-settings";

/** Reference images are dropped on save — see saveSettings. */
type PersistedSettings = Omit<GenerationSettings, "vibe" | "directorReference">;

export function loadSettings(): GenerationSettings | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    // Merged over the defaults so a field added to GenerationSettings later can never come back
    // as undefined from an older stored payload.
const settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<GenerationSettings>) };
    // Earlier V5 support automatically forced this incorrect pair. Migrate only that exact legacy
    // combination so intentional custom values remain untouched.
    if (isV5Model(settings.model) && settings.steps === 23 && settings.scale === 7) {
      settings.steps = 28;
      settings.scale = 4;
    }
    return settings;
  } catch {
    return null;
  }
}

export function saveSettings(s: GenerationSettings) {
  if (typeof localStorage === "undefined") return;
  // `vibe` and `directorReference` each carry a full base64 payload *and* a preview data-URL, so a
  // handful of references blows the ~5MB quota. A QuotaExceededError here would take down
  // persistence of everything else — including the prompt — so dropping them is the correct
  // behaviour rather than a compromise.
  const { vibe: _v, directorReference: _d, ...rest } = s;
  const persisted: PersistedSettings = rest;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
  } catch {
    // Persistence the user never asked for must not interrupt them.
  }
}

const UI_KEY = "nya-ui";

export type UIPrefs = { settingsCollapsed: boolean; activeTab: "basic" | "advanced" | "characters"; galleryOpen: boolean };

export function loadUIPrefs(): UIPrefs | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(UI_KEY);
    return raw ? (JSON.parse(raw) as UIPrefs) : null;
  } catch {
    return null;
  }
}

/**
 * Panel layout only. Notably absent: `focusedIndex` — restoring an open lightbox over an image the
 * user didn't ask to see is hostile — and `showConnect`, which is derived from whether a client exists.
 */
export function saveUIPrefs(p: UIPrefs) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(p));
  } catch {
    /* non-essential */
  }
}

export type TokenVerdict = "ok" | "invalid" | "unknown";

export type AccountStatus = {
  tier: number;
  tierName: "Paper" | "Tablet" | "Scroll" | "Opus" | "Unknown";
  active: boolean;
  expiresAt: number | null;
  anlasBalance: number;
  fixedAnlas: number;
  purchasedAnlas: number;
  isGracePeriod: boolean;
  accountType: number | null;
  opusUsage: { percent: number; isNegative: boolean; timeUntilNextPercent: number } | null;
  refreshedAt: number;
};

export type V5QuotaStatus = Pick<AccountStatus, "tier" | "active" | "opusUsage" | "refreshedAt">;

type SubscriptionPayload = {
  tier?: number;
  active?: boolean;
  expiresAt?: number;
  trainingStepsLeft?: number | {
    fixedTrainingStepsLeft?: number;
    purchasedTrainingSteps?: number;
  };
  isGracePeriod?: boolean;
  accountType?: number;
  usage?: { percent?: number; isNegative?: boolean; timeUntilNextPercent?: number };
};

function parseSubscription(payload: SubscriptionPayload): AccountStatus {
  const tier = Number(payload.tier || 0);
  const tierName = (["Paper", "Tablet", "Scroll", "Opus"][tier] || "Unknown") as AccountStatus["tierName"];
  const steps = payload.trainingStepsLeft;
  const fixedAnlas = typeof steps === "number"
    ? steps
    : Number(steps?.fixedTrainingStepsLeft || 0);
  const purchasedAnlas = typeof steps === "number"
    ? 0
    : Number(steps?.purchasedTrainingSteps || 0);
  const privileged = [1, 2, 3, 4].includes(Number(payload.accountType));
  const expiresAt = Number.isFinite(Number(payload.expiresAt)) ? Number(payload.expiresAt) : null;
  const activeByExpiry = expiresAt !== null ? expiresAt * 1000 > Date.now() : Boolean(payload.active);
  return {
    tier,
    tierName,
    active: privileged || (tier > 0 && activeByExpiry),
    expiresAt,
    anlasBalance: fixedAnlas + purchasedAnlas,
    fixedAnlas,
    purchasedAnlas,
    isGracePeriod: Boolean(payload.isGracePeriod),
    accountType: Number.isFinite(Number(payload.accountType)) ? Number(payload.accountType) : null,
    opusUsage: parseOpusUsage(payload.usage),
    refreshedAt: Date.now(),
  };
}

async function readSubscription(cfg: ConnectionConfig, label: string): Promise<SubscriptionPayload> {
  let response: Response;
  try {
    response = await fetchSubscription(cfg);
  } catch (error) {
    const timeout = error instanceof Error && /timeout|abort/i.test(error.name);
    throw new Error(label + "查询失败：" + (timeout ? "请求超时" : "网络连接失败，手机浏览器也可能受 CORS 限制") + "（image.novelai.net/user/subscription；未自动重试）");
  }
  if (!response.ok) {
    throw new Error(label + "查询失败：" + (await subscriptionFailure(response, normalizeNovelAIToken(cfg.token))).message);
  }
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(label + "查询失败：接口未返回有效 JSON 对象");
  return payload as SubscriptionPayload;
}

export async function fetchAccountStatus(cfg: ConnectionConfig): Promise<AccountStatus | null> {
  if (cfg.host !== Host.WEB) return null;
  const payload = await readSubscription(cfg, "Anlas 点数");
  const steps = payload.trainingStepsLeft;
  const amounts = typeof steps === "number" ? [steps] : [steps?.fixedTrainingStepsLeft, steps?.purchasedTrainingSteps];
  if (amounts.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new Error("Anlas 点数查询失败：接口未返回完整有效的 trainingStepsLeft 余额；不会当作 0 点");
  }
  return parseSubscription(payload);
}

export async function fetchV5Quota(cfg: ConnectionConfig): Promise<V5QuotaStatus | null> {
  if (cfg.host !== Host.WEB) return null;
  const payload = await readSubscription(cfg, "V5 免费额度");
  if (typeof payload.tier !== "number" || !Number.isFinite(payload.tier)) throw new Error("V5 免费额度查询失败：接口缺少订阅等级，无法判断适用性");
  const { tier, active, opusUsage, refreshedAt } = parseSubscription(payload);
  if (active && tier === 3 && !opusUsage) throw new Error("V5 免费额度查询失败：接口未返回有效 usage 字段；不代表 0% 或无限");
  return { tier, active, opusUsage, refreshedAt };
}

/**
 * Cheap authentication probe, so the UI can stop claiming "Connected" about a token it never
 * checked. Constructing a NaiClient performs zero I/O, so without this a truncated token gets a
 * green dot and a success toast, then fails forty seconds later behind a shimmer.
 *
 * Deliberately NOT `suggestTags`: that endpoint is unauthenticated and returns real results for a
 * garbage token, so it would wave every bad key through.
 *
 * For default (NovelAI) hosts, probes the account subscription route.
 *
 * For custom hosts (NyaProxy and similar gateways), the account route doesn't exist, but NyaProxy
 * authenticates every proxied path via the Authorization header and answers with a fixed
 * `{"error":"Unauthorized: NyaProxy - Invalid API key"}` (403) when the key is rejected — before
 * any forwarding happens. Probing `${host}/ai/generate-image-stream` therefore distinguishes
 * "key rejected" (403 + NyaProxy body) from "host reachable, key accepted" (any other status,
 * e.g. 404/405 from the upstream, which is fine for a base URL). This catches a wrong or
 * wrong-typed key (NovelAI pst-token pasted where the gateway's own proxy key belongs) at connect
 * time instead of on the first generation.
 *
 * Returns "unknown" — never "invalid" — for anything that isn't a hard 401/403 from the host
 * itself. A network blip or a CORS failure must not lock a user out of their own client.
 */
export async function verifyToken(cfg: ConnectionConfig): Promise<TokenVerdict> {
  if (cfg.host !== Host.WEB) {
    try {
      // Probe the gateway's own auth boundary through our server-side proxy (same-origin, so no
      // CORS). NyaProxy rejects unknown keys with a fixed 403 before forwarding, so a 403 means
      // the key is wrong for this host.
      const res = await fetch(IS_STATIC_PWA ? `${cfg.host.replace(/\/+$/, "")}/ai/generate-image-stream` : "/api/proxy/ai/generate-image-stream", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          ...(!IS_STATIC_PWA ? { "x-nya-target": cfg.host } : {}),
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) return "invalid";
      return "ok";
    } catch {
      return "unknown";
    }
  }
  try {
    const res = await fetchSubscription(cfg);
    // A 403 from this account-only route is ambiguous: an edge policy can
    // reject it while image generation with the same token still succeeds.
    if (res.status === 401) return "invalid";
    if (res.status === 403) return "unknown";
    return res.ok ? "ok" : "unknown";
  } catch {
    return "unknown";
  }
}

export async function fetchAnlasBalance(cfg: ConnectionConfig): Promise<number | null> {
  try {
    return (await fetchAccountStatus(cfg))?.anlasBalance ?? null;
  } catch { return null; }
}

// ---- Client wrapper ----

const MAX_SEED = 4294967295;
const randomSeed = () => Math.floor(Math.random() * MAX_SEED);

export type GenerateHandle = {
  /** The concrete seed used (a random one is drawn when settings.seed is -1). */
  seed: number;
  /** V4/V4.5 stream intermediate frames; V3 resolves once with final images. */
  streaming: boolean;
  events: AsyncGenerator<MsgpackEvent, void, unknown>;
};

async function* finalImageEvents(images: Image[], steps: number) {
  for (const [sampleIndex, image] of images.entries()) {
    yield new MsgpackEvent({
      event_type: EventType.FINAL,
      samp_ix: sampleIndex,
      step_ix: steps,
      gen_id: "non-streaming",
      sigma: 0,
      image,
    });
  }
}

const V5_UC = [
  "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
  "lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::",
  "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy",
  "",
];

function joinPrompt(first: string, second: string) {
  return [first.trim(), second.trim()].filter(Boolean).join(", ");
}

function v5Payload(settings: GenerationSettings, seed: number) {
  const negative = joinPrompt(V5_UC[settings.ucPreset] || "", settings.negativePrompt);
  const characters = settings.characters.filter((character) => character.enabled && character.prompt.trim()).slice(0, V5_MAX_CHARACTERS);
  const charCaptions = characters.map((character) => ({ char_caption: character.prompt.trim(), centers: [character.center] }));
  const negativeCharCaptions = characters.map((character) => ({ char_caption: character.uc.trim(), centers: [character.center] }));
  const characterPrompts = characters.map((character) => ({ center: character.center, prompt: character.prompt.trim(), uc: character.uc.trim(), enabled: true }));
  const useCoords = characterPrompts.some((character) => character.center.x !== 0.5 || character.center.y !== 0.5);
  const { prompt } = buildV5Prompt(toMetadata(settings, seed).prompt || "", {
    qualityToggle: settings.qualityToggle,
    qualityTier: settings.qualityTier,
    transparentBackground: settings.transparentBackground,
    characters,
    useCoords,
  });
  return {
    input: prompt,
    model: settings.model,
    action: "generate",
    parameters: {
      params_version: 4,
      width: settings.width,
      height: settings.height,
      scale: settings.scale,
      sampler: settings.sampler === "ddim_v3" ? "k_euler_ancestral" : settings.sampler,
      steps: settings.steps,
      n_samples: settings.nSamples,
      ucPresetId: ["heavy", "light", "humanFocus", "none"][settings.ucPreset],
      qualityPresetId: settings.qualityToggle ? settings.qualityTier : "none",
      tag_hint_qt: v5QualityTagHint(settings.qualityToggle, settings.qualityTier),
      tag_hint_uc_preset: [2, 3, 4, 0][settings.ucPreset],
      autoSmea: false,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      cfg_rescale: settings.cfgRescale,
      noise_schedule: settings.noiseSchedule,
      seed,
      negative_prompt: negative,
      legacy_v3_extend: false,
      legacy_uc: false,
      normalize_reference_strength_multiple: true,
      straight_alpha: settings.straightAlpha,
      ...(settings.transparentBackground ? { tag_hint_transparent_background: true } : {}),
      use_coords: useCoords,
      v4_prompt: { caption: { base_caption: prompt, char_captions: charCaptions }, use_coords: useCoords, use_order: true },
      v4_negative_prompt: { caption: { base_caption: negative, char_captions: negativeCharCaptions }, legacy_uc: false },
      characterPrompts,
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
      image_format: "png",
      stream: "msgpack",
    },
  };
}

type RawStreamingClient = {
  host: string;
  openStream: (url: string, payload: unknown) => Promise<Response>;
  parseEventStream: (response: Response, action: string) => AsyncGenerator<MsgpackEvent, void, unknown>;
};

/**
 * True when the host is a custom gateway (not NovelAI's own image host). Custom gateways often
 * sit behind an Nginx that enforces a CORS origin whitelist, which blocks browser requests from
 * our origin. When this is the case we route traffic through our own server-side proxy
 * (app/api/proxy/[...path]/route.ts) to bypass the browser CORS restriction.
 */
function usesProxy(cfg: ConnectionConfig): boolean {
  return !IS_STATIC_PWA && cfg.host !== Host.WEB;
}

export class NaiClient {
  readonly raw: NovelAI;
  private readonly retry: { enabled: boolean; maxRetries: number; baseDelay: number; maxDelay: number; retryStatusCodes: number[] };

  constructor(cfg: ConnectionConfig) {
    cfg = normalizeConnection(cfg);
    const viaProxy = usesProxy(cfg);
    this.retry = {
      enabled: cfg.maxRetries > 0,
      maxRetries: cfg.maxRetries,
      baseDelay: cfg.baseDelay,
      maxDelay: 60000,
      retryStatusCodes: [429, 500, 502, 503, 504],
    };
    this.raw = new NovelAI({
      token: cfg.token,
      // For custom gateways, point nekoai-js at our same-origin proxy route instead of the
      // cross-origin host. The real target travels in x-nya-target so the proxy knows where to
      // forward. (nekoai-js concatenates host + path as plain strings and accepts a relative
      // host, so "/api/proxy" + "/ai/generate-image-stream" resolves against our own origin.)
      host: viaProxy ? "/api/proxy" : cfg.host,
      retry: this.retry,
    });
    if (viaProxy) {
      // Tell the proxy where to forward. nekoai-js builds its request headers from this object,
      // so a plain property assignment is enough.
      (this.raw as unknown as { headers: Record<string, string> }).headers["x-nya-target"] = cfg.host;
    }
  }

  /** Start a streaming generation. Returns the resolved seed and the event stream. */
  async generate(settings: GenerationSettings): Promise<GenerateHandle> {
    const seed = settings.seed >= 0 ? settings.seed : randomSeed();
    const meta = toMetadata(settings, seed);
    const streaming = isV4Model(settings.model);
    if (isV5Model(settings.model)) {
      const raw = this.raw as unknown as RawStreamingClient;
      const response = await withRetry(
        () => raw.openStream(raw.host + "/ai/generate-image-stream", v5Payload(settings, seed)),
        this.retry,
      );
      return { seed, streaming: true, events: raw.parseEventStream(response, "generate") };
    }
    if (streaming) {
      const events = await this.raw.generateImage(meta, true);
      return { seed, streaming, events };
    }

    // NovelAI's V3 endpoints return a ZIP containing only final images. Adapt that array to the
    // same event contract used by the store so persistence, batches, and per-sample seeds stay on
    // one path without pretending that V3 supports intermediate previews.
    const images = await this.raw.generateImage(meta, false);
    return { seed, streaming, events: finalImageEvents(images, settings.steps) };
  }

  suggestTags(prompt: string) {
    return this.raw.suggestTags(prompt);
  }

  // Director tools (operate on an existing image).
  lineArt = (img: ImageInput) => this.raw.lineArt(img);
  sketch = (img: ImageInput) => this.raw.sketch(img);
  backgroundRemoval = (img: ImageInput) => this.raw.backgroundRemoval(img);
  declutter = (img: ImageInput) => this.raw.declutter(img);
  colorize = (img: ImageInput, prompt?: string, defry?: number) =>
    this.raw.colorize(img, prompt, defry);
  changeEmotion = (img: ImageInput, emotion?: EmotionOptions, prompt?: string, level?: number) =>
    this.raw.changeEmotion(img, emotion, prompt, level);
  upscale = (img: ImageInput, scale: 2 | 4 = 4) => this.raw.upscale(img, scale);
  enhance = (img: ImageInput) => this.raw.enhance(img);
}

export { EventType, parseImage };
export type { Image, MsgpackEvent };

/** Parse a File/Blob into base64 + a preview data-url for the vibe/reference form. */
export async function parseReference(file: File | Blob) {
  const parsed = await parseImage(file);
  return { base64: parsed.base64, preview: `data:image/png;base64,${parsed.base64}` };
}
