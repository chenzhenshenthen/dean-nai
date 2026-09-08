// Offline regressions: real store/policy code with fake account, generator, storage and clock.
// Never reads tokens, accesses the network, or submits a paid generation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
function compile(file, imports = {}, globals = {}) {
  const output = ts.transpileModule(readFileSync(root + file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const context = vm.createContext({
    exports: {}, console: { ...console, error() {} }, process: { env: {} },
    require(name) { if (name in imports) return imports[name]; throw new Error("Unmocked dependency: " + name); },
    ...globals,
  });
  vm.runInContext(output, context, { filename: file });
  return context.exports;
}
const prefsModule = compile("lib/app-preferences.ts");
const policyModule = compile("lib/automatic-generation.ts");
const usageModule = compile("lib/account-usage.ts");
test("V5 张数仅按脚本参考值估算，未知不当作零，透支归零，超过100%不截断", () => {
  const { estimateV5RemainingImages: estimate } = usageModule;
  const usage = (percent, isNegative = false) => ({ percent, isNegative, timeUntilNextPercent: 0 });
  assert.equal(estimate(usage(100)), 1700);
  assert.equal(estimate(usage(50)), 850);
  assert.equal(estimate(usage(73.25)), 1245);
  assert.equal(estimate(usage(125)), 2125);
  assert.equal(estimate(usage(0)), 0);
  assert.equal(estimate(usage(-10)), 0);
  assert.equal(estimate(usage(30, true)), 0);
  for (const value of [null, undefined, usage(NaN), usage(Infinity), usage(Number.MAX_VALUE)]) assert.equal(estimate(value), null);
});
const normalize = prefsModule.normalizeAppPreferences;
const { automaticDelayMs, automaticStopReason } = policyModule;
const run = (overrides = {}) => ({ id: 1, startedAt: 100000, generated: 1, estimatedSpent: 0, nextAt: null, policy: normalize({}), ...overrides });

test("旧设置安全迁移，默认不自动继续，独立随机开关", () => {
  const p = normalize({});
  assert.equal(p.gachaAutoGenerate, false);
  assert.equal(p.gachaRandomScene, true);
  assert.equal(p.gachaRandomArtist, false);
  assert.equal(p.gachaAnlasBudget, 0);
  assert.equal(p.gachaMaxImages, 20);
  assert.equal(normalize({ gachaMaxImages: -1 }).gachaMaxImages, 1);
  assert.equal(normalize({ gachaAutoGenerateIntervalSeconds: 90, gachaMaxIntervalSeconds: 20 }).gachaMaxIntervalSeconds, 90);
});
test("随机间隔边界、基础间隔保护与周期休息", () => {
  assert.equal(automaticDelayMs(run(), 0), 30000);
  assert.equal(automaticDelayMs(run(), 1), 60000);
  assert.equal(automaticDelayMs(run({ generated: 10 }), 0), 330000);
  assert.equal(automaticDelayMs(run({ policy: normalize({ generationIntervalSeconds: 120 }) }), 0), 120000);
});
test("张数、时间、预算、错误估价边界", () => {
  assert.match(automaticStopReason(run({ generated: 20 }), 100000), /张数/);
  assert.match(automaticStopReason(run(), 100000 + 1800000), /时长/);
  assert.match(automaticStopReason(run(), 100000, 1), /预算/);
  assert.equal(automaticStopReason(run(), 100000, 0), null);
  assert.match(automaticStopReason(run(), 99999), /时间/);
  assert.match(automaticStopReason(run(), 100000, NaN), /估算/);
});
test("额度缺失不是零；透支为零；超过100%不丢失", () => {
  const { parseOpusUsage: parse, remainingOpusPercent: remaining } = usageModule;
  for (const input of [undefined, null, {}, { percent: null }, { percent: NaN, isNegative: false }]) assert.equal(parse(input), null);
  assert.equal(remaining(parse({ percent: 125.5, isNegative: false })), 125.5);
  assert.equal(remaining(parse({ percent: 3, isNegative: true })), 0);
  assert.equal(remaining(null), null);
});

function clientHarness({ pwa = false, status = 200, payload, contentType = "application/json" } = {}) {
  const requests = [], configurations = [];
  const client = compile("lib/nai/client.ts", {
    "nekoai-js": { Host: { WEB: "official", API: "old-host" }, NovelAI: class { constructor(config) { configurations.push(config); } } },
    "./types": { DEFAULT_SETTINGS: {} },
    "./models": {},
    "./v5-prompt": {},
    "../account-usage": usageModule,
    "./subscription-error": compile("lib/nai/subscription-error.ts"),
    "./token": compile("lib/nai/token.ts"),
  }, {
    AbortSignal,
    process: { env: { NEXT_PUBLIC_STATIC_PWA: pwa ? "1" : "0" } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const body = payload === undefined ? ({
        tier: 3, active: true,
        trainingStepsLeft: { fixedTrainingStepsLeft: 120, purchasedTrainingSteps: 30 },
        usage: { percent: 73.25, isNegative: false, timeUntilNextPercent: 120 },
      }) : payload;
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } });
    },
  });
  return { client, requests, configurations };
}
test("Token 输入默认遮挡，手动显示，粘贴换行不会截断正文", () => {
  let visible = false, changed = null, prevented = false;
  const tokenModule = compile("lib/nai/token.ts");
  const { TokenInput } = compile("components/token-input.tsx", {
    react: { useId: () => "test-hint", useState: () => [visible, (update) => { visible = update(visible); }] },
    "react/jsx-runtime": require("react/jsx-runtime"),
    "lucide-react": { Eye: "eye", EyeOff: "eye-off" },
    "@/components/ui/input": { Input: "input" },
    "@/lib/nai/token": tokenModule,
  });
  const props = { value: "", onValueChange: (value) => { changed = value; } };
  const elements = (node) => !node || typeof node !== "object" ? [] : [node, ...[].concat(node.props?.children ?? []).flatMap(elements)];
  let nodes = elements(TokenInput(props));
  const input = nodes.find((node) => node.type === "input");
  assert.equal(input.props.type, "password");
  input.props.onPaste({ clipboardData: { getData: () => '"Bearer pst-offline-\n test"' }, currentTarget: { selectionStart: 0, selectionEnd: 0 }, preventDefault: () => { prevented = true; } });
  assert.equal(changed, "pst-offline-test");
  assert.equal(prevented, true);
  nodes.find((node) => node.type === "button").props.onClick();
  nodes = elements(TokenInput({ ...props, value: changed }));
  assert.equal(nodes.find((node) => node.type === "input").props.type, "text");
  nodes.find((node) => node.type === "button").props.onClick();
  assert.equal(elements(TokenInput(props)).find((node) => node.type === "input").props.type, "password");
});

test("Token 清理不截断正文，拒绝遮挡文字，不改写第三方密钥", () => {
  const { normalizeNovelAIToken: clean, hasNovelAITokenFormat: valid } = compile("lib/nai/token.ts");
  const token = "pst-AbC_123+/=-test";
  assert.equal(clean(token), token);
  assert.equal(clean(' "Bearer Bearer pst-AbC_123+/=\n-test" '), token);
  assert.equal(clean("Bearer 'pst-AbC_123+/=-test'"), token);
  assert.equal(valid(token), true);
  for (const bad of ["", "pst-", "pst-...", "••••", "******", "pst-secret…", "pst-secret***", "pst-" + "a".repeat(4096)]) assert.equal(valid(bad), false);
  const h = clientHarness();
  assert.equal(h.client.normalizeConnection({ host: "official", token: ' "Bearer pst-offline" ' }).token, "pst-offline");
  assert.equal(h.client.normalizeConnection({ host: "custom", token: ' "Bearer other key" ' }).token, '"Bearer other key"');
});

test("JSON 代理和 PWA 请求均使用完整清理后的 Token", async () => {
  for (const pwa of [false, true]) {
    const h = clientHarness({ pwa });
    const cfg = { host: "official", token: ' "Bearer pst-offline-\n test" ' };
    await h.client.fetchAccountStatus(cfg);
    const { options } = h.requests[0];
    assert.equal(pwa ? options.headers.Authorization : JSON.parse(options.body).token,
      pwa ? "Bearer pst-offline-test" : "pst-offline-test");
    new h.client.NaiClient(cfg);
    assert.equal(h.configurations[0].token, "pst-offline-test");
  }
});

test("Next 代理与桌面代理使用相同请求配置，无自动重试", async () => {
  const calls = [];
  const route = compile("app/api/novelai/subscription/route.ts", {
    "@/lib/nai/token": compile("lib/nai/token.ts"),
  }, { Response, AbortSignal, fetch: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ tier: 3, usage: { percent: 73.25 } });
  } });
  const response = await route.POST({ json: async () => ({ token: ' "Bearer pst-offline-\n test" ' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).usage.percent, 73.25);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer pst-offline-test");
  assert.equal(calls[0].options.headers["User-Agent"], "deanai/2.0.0");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await route.POST({ json: async () => ({ token: "pst-***" }) })).status, 400);
  assert.equal(calls.length, 1);
});

test("实际账户解析保留余额组成和V5百分比", async () => {
  const h = clientHarness();
  const account = await h.client.fetchAccountStatus({ host: "official", token: "fake" });
  assert.equal(account.anlasBalance, 150);
  assert.equal(account.fixedAnlas, 120);
  assert.equal(account.purchasedAnlas, 30);
  assert.equal(account.opusUsage.percent, 73.25);
  assert.equal(h.requests[0].url, "/api/novelai/subscription");
});
test("PWA账户查询直连图像服务且不缓存", async () => {
  const h = clientHarness({ pwa: true });
  await h.client.fetchAccountStatus({ host: "official", token: "fake" });
  assert.equal(h.requests[0].url, "https://image.novelai.net/user/subscription");
  assert.equal(h.requests[0].options.cache, "no-store");
});
test("账户HTTP错误保留状态码且不重试", async () => {
  const h = clientHarness({ status: 429 });
  await assert.rejects(h.client.fetchAccountStatus({ host: "official", token: "fake" }), /429/);
  assert.equal(h.requests.length, 1);
});
test("自动客户端同时设置重试关闭和重试次数0", () => {
  const h = clientHarness();
  new h.client.NaiClient({ host: "official", token: "fake", maxRetries: 0, baseDelay: 2000 });
  assert.equal(h.configurations[0].retry.enabled, false);
  assert.equal(h.configurations[0].retry.maxRetries, 0);
});

test("Anlas 有效但缺少 usage 时仍能显示余额，V5 独立报错", async () => {
  const h = clientHarness({ payload: { tier: 3, active: true, trainingStepsLeft: 250 } });
  const cfg = { host: "official", token: "fake" };
  assert.equal((await h.client.fetchAccountStatus(cfg)).anlasBalance, 250);
  await assert.rejects(h.client.fetchV5Quota(cfg), /V5.*usage/);
  assert.equal(h.requests.length, 2);
});

test("V5 有效但缺少余额字段时仍能显示免费额度，Anlas 不伪造零", async () => {
  const h = clientHarness({ payload: { tier: 3, active: true, usage: { percent: 87, isNegative: false } } });
  const cfg = { host: "official", token: "fake" };
  assert.equal((await h.client.fetchV5Quota(cfg)).opusUsage.percent, 87);
  await assert.rejects(h.client.fetchAccountStatus(cfg), /Anlas.*trainingStepsLeft/);
});

test("两项 403 独立标注查询名称，不重试且隐藏 Token", async () => {
  const token = "pst-offline-secret";
  const h = clientHarness({ status: 403, payload: { error: "rejected " + token } });
  for (const [method, label] of [["fetchAccountStatus", "Anlas"], ["fetchV5Quota", "V5"]]) {
    await assert.rejects(h.client[method]({ host: "official", token }), (error) => {
      assert.ok(error.message.includes(label));
      assert.ok(error.message.includes("403"));
      assert.ok(!error.message.includes(token));
      return true;
    });
  }
  assert.equal(h.requests.length, 2);
});

test("V5 缺少订阅等级报错，非 Opus 不伪造百分比", async () => {
  await assert.rejects(clientHarness({ payload: {} }).client.fetchV5Quota({ host: "official", token: "fake" }), /订阅等级/);
  const quota = await clientHarness({ payload: { tier: 1, active: true } }).client.fetchV5Quota({ host: "official", token: "fake" });
  assert.equal(quota.tier, 1);
  assert.equal(quota.opusUsage, null);
});

test("同时刷新 Anlas 和 V5 共享一次真实请求，响应可分别解析", async () => {
  const h = clientHarness();
  const cfg = { host: "official", token: "fake" };
  const [account, quota] = await Promise.all([h.client.fetchAccountStatus(cfg), h.client.fetchV5Quota(cfg)]);
  assert.equal(account.anlasBalance, 150);
  assert.equal(quota.opusUsage.percent, 73.25);
  assert.equal(h.requests.length, 1);
});

test("1010 保留 detail 和 Ray ID，本次会话后续调用不再请求", async () => {
  const h = clientHarness({ status: 403, payload: { error_code: 1010, error_name: "browser_signature_banned", detail: "Denied based on client signature", ray_id: "offline-ray-1010" } });
  const cfg = { host: "official", token: "fake" };
  await assert.rejects(h.client.fetchAccountStatus(cfg), /Cloudflare 1010.*Denied based on client signature.*offline-ray-1010/);
  await assert.rejects(h.client.fetchV5Quota(cfg), /Cloudflare 1010/);
  assert.equal(await h.client.verifyToken({ ...cfg }), "unknown");
  assert.equal(h.requests.length, 1);
});

test("纯文本错误脱敏，HTML 只显示标题，避免输出完整页面", async () => {
  const text = clientHarness({ status: 403, payload: "Rejected pst-hidden-token", contentType: "text/plain" });
  await assert.rejects(text.client.fetchAccountStatus({ host: "official", token: "fake" }), (error) => {
    assert.ok(error.message.includes("Rejected")); assert.ok(!error.message.includes("pst-hidden-token")); return true;
  });
  const html = clientHarness({ status: 403, payload: "<title>Denied</title><script>PRIVATE_SCRIPT</script>", contentType: "text/html" });
  await assert.rejects(html.client.fetchAccountStatus({ host: "official", token: "fake" }), (error) => {
    assert.ok(error.message.includes("Denied")); assert.ok(!error.message.includes("PRIVATE_SCRIPT")); return true;
  });
});

test("普通 403 不冒充 1010，后续手动查询不被永久锁死", async () => {
  const h = clientHarness({ status: 403, payload: { detail: "ordinary rejection" } });
  const cfg = { host: "official", token: "fake" };
  await assert.rejects(h.client.fetchAccountStatus(cfg), /ordinary rejection/);
  await assert.rejects(h.client.fetchAccountStatus(cfg), /ordinary rejection/);
  assert.equal(h.requests.length, 2);
});

function harness(options = {}) {
  let clock = 2_000_000_000_000;
  let preferences = normalize({ gachaAutoGenerate: true, ...options.preferences });
  let generated = 0, saved = 0, accountCalls = 0;
  const requests = [], draws = [], timers = new Map(), configs = [], notices = [];
  const account = { tier: 3, active: true, anlasBalance: 100, opusUsage: { percent: 80, isNegative: false }, ...options.account };
  const settings = { model: "v5", prompt: "test", artistPrompt: "old artist", scenePrompt: "old scene", characters: [], nSamples: 3, seed: -1, steps: 28, width: 832, height: 1216 };
  class MockDate extends Date { static now() { return clock; } }
  const toast = Object.assign((message) => notices.push(message), { error: (m) => notices.push(m), info: (m) => notices.push(m) });
  class Client {
    constructor(config) { configs.push(config); }
    async generate(s) {
      generated++; requests.push(s);
      if (options.onGenerate) await options.onGenerate(api);
      if (options.generationError) throw new Error(options.generationError);
      return { seed: 42, streaming: true, events: (async function* () {
        for (let index = 0; index < (options.empty ? 0 : s.nSamples); index++) yield { event_type: "final", samp_ix: index, image: { toDataURL: () => "data:image/png;base64,test" } };
        if (options.streamError) throw new Error(options.streamError);
      })() };
    }
  }
  const windowEvents = {}, documentEvents = {};
  const fakeWindow = {
    setTimeout(fn, ms) { const id = timers.size + 1; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    matchMedia: () => ({ matches: false }),
    confirm: () => true,
    addEventListener: (event, fn) => { windowEvents[event] = fn; },
  };
  const fakeDocument = { hidden: false, addEventListener: (event, fn) => { documentEvents[event] = fn; } };
  const fakeNavigator = { onLine: true, locks: { request: async (_name, _opts, fn) => fn(options.lockUnavailable ? null : {}) } };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const imported = {
    zustand: require("zustand"), sonner: { toast },
    "@/lib/nai/client": { NaiClient: Client, EventType: { FINAL: "final", INTERMEDIATE: "intermediate" },
      loadConnection: () => null, saveSettings() {}, saveUIPrefs() {}, loadSettings: () => null, loadUIPrefs: () => null,
      fetchAccountStatus: async () => { accountCalls++; return options.onAccount ? options.onAccount(api, accountCalls) : options.accountUnavailable ? null : account; },
      fetchV5Quota: async () => options.onQuota ? options.onQuota(api) : account },
    "@/lib/nai/types": { DEFAULT_SETTINGS: settings, composePositivePrompt: (s) => [s.prompt, s.scenePrompt, s.artistPrompt].filter(Boolean).join(",") },
    "@/lib/nai/models": { estimateGenerationCost: () => options.cost || 0, isV4Model: () => true, isV5Model: (model) => model === "v5" },
    "nekoai-js": { Host: { WEB: "official" } },
    "@/lib/app-preferences": { loadAppPreferences: () => preferences, renderFilename: () => "test.png" },
    "@/lib/automatic-generation": policyModule,
    "@/lib/image-actions": { saveDataUrl: async () => { if (options.saveError) throw new Error("disk full"); } },
    "@/lib/client-log": { reportClientEvent() {} },
    "@/lib/generation-counter": { initializeGenerationLedger() {}, recordGeneratedImages() {} },
    "@/lib/random-library": { drawRandomLibraryEntry: async (kind) => { draws.push(kind); if (options.onDraw) await options.onDraw(api); return { content: "new " + kind, title: kind }; } },
    "@/lib/db/gallery": { ACTIVE_GALLERY_LIMIT: 100, loadImages: async () => [], saveImage: async () => ++saved },
  };
  const store = compile("lib/store.ts", imported, {
    window: fakeWindow, document: fakeDocument, navigator: fakeNavigator, Date: MockDate,
    localStorage: storage, sessionStorage: storage, setTimeout: () => 1, clearTimeout() {},
  }).useStore;
  store.setState({ connection: { host: options.host || "official", token: "fake-test-token", maxRetries: 3 }, client: new Client({ maxRetries: 3 }), accountStatus: account, settings });
  const api = {
    store, timers, configs, requests, draws, notices, account,
    get generated() { return generated; }, get saved() { return saved; }, get accountCalls() { return accountCalls; },
    start() { store.getState().setGachaMode(true); return store.getState().generate(); },
    prefs(patch) { preferences = normalize({ ...preferences, ...patch }); },
    async tick(late = 0) {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id); clock = timer.at + late; timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
    async settle() { await new Promise((resolve) => setImmediate(resolve)); },
  };
  return api;
}

test("额度刷新并行：V5 慢请求不阻塞 Anlas 显示", async () => {
  let finishQuota;
  const h = harness({ onQuota: () => new Promise((resolve) => { finishQuota = resolve; }) });
  const quotaRequest = h.store.getState().refreshV5Quota();
  assert.equal(h.store.getState().v5QuotaRefreshing, true);
  await h.store.getState().refreshAnlas();
  assert.equal(h.store.getState().anlasBalance, 100);
  assert.equal(h.store.getState().accountRefreshing, false);
  assert.equal(h.store.getState().v5QuotaRefreshing, true);
  finishQuota(h.account);
  await quotaRequest;
  assert.equal(h.store.getState().v5Quota.opusUsage.percent, 80);
});

test("V5 查询失败不清除 Anlas 或其成功状态", async () => {
  const h = harness({ onQuota: async () => { throw new Error("V5 HTTP 403"); } });
  await Promise.all([h.store.getState().refreshAnlas(), h.store.getState().refreshV5Quota()]);
  assert.equal(h.store.getState().anlasBalance, 100);
  assert.equal(h.store.getState().accountError, null);
  assert.match(h.store.getState().v5QuotaError, /V5.*403/);
});

test("Anlas 查询失败不清除 V5 或其成功状态", async () => {
  const h = harness({ onAccount: async () => { throw new Error("Anlas HTTP 403"); } });
  await Promise.all([h.store.getState().refreshAnlas(), h.store.getState().refreshV5Quota()]);
  assert.match(h.store.getState().accountError, /Anlas.*403/);
  assert.equal(h.store.getState().v5Quota.opusUsage.percent, 80);
  assert.equal(h.store.getState().v5QuotaError, null);
});

test("切换账号后旧 V5 响应不得覆盖新账号", async () => {
  let finishQuota;
  const h = harness({ onQuota: () => new Promise((resolve) => { finishQuota = resolve; }) });
  const request = h.store.getState().refreshV5Quota();
  h.store.setState({ connection: { host: "official", token: "another-fake-token" }, v5Quota: null, v5QuotaRefreshing: true });
  finishQuota(h.account);
  await request;
  assert.equal(h.store.getState().v5Quota, null);
  assert.equal(h.store.getState().v5QuotaRefreshing, true);
});

test("自动模式每请求一张，不改手动批量，双随机且不重试", async () => {
  const h = harness({ preferences: { gachaRandomArtist: true } }); await h.start();
  assert.equal(h.generated, 1); assert.equal(h.requests[0].nSamples, 1);
  assert.equal(h.store.getState().settings.nSamples, 3);
  assert.equal(h.configs.at(-1).maxRetries, 0);
  assert.deepEqual(h.draws, ["prompt", "artist"]);
  assert.equal(h.store.getState().automaticRun.generated, 1);
  assert.equal(h.timers.size, 1);
});
test("仅抽卡不连续生成，保留手动批量", async () => {
  const h = harness({ preferences: { gachaAutoGenerate: false } }); await h.start();
  assert.equal(h.saved, 3); assert.equal(h.timers.size, 0); assert.deepEqual(h.draws, ["prompt"]);
});
test("两个随机开关均关闭时保留提示词", async () => {
  const h = harness({ preferences: { gachaRandomScene: false, gachaRandomArtist: false } }); await h.start();
  assert.equal(h.draws.length, 0); assert.equal(h.store.getState().settings.scenePrompt, "old scene");
  await h.tick(); assert.equal(h.generated, 2);
});
test("恰好达到张数上限停止，不多发一张", async () => {
  const h = harness({ preferences: { gachaMaxImages: 2 } }); await h.start(); await h.tick();
  assert.equal(h.generated, 2); assert.equal(h.timers.size, 0); assert.equal(h.store.getState().gachaMode, false);
});
test("长等待仍按运行时限停止", async () => {
  const h = harness({ preferences: { gachaMaxMinutes: 1, gachaAutoGenerateIntervalSeconds: 120, gachaMaxIntervalSeconds: 120 } }); await h.start(); await h.tick();
  assert.equal(h.generated, 1); assert.match(h.store.getState().automaticStopMessage, /时长/);
});
for (const generationError of ["HTTP 429", "HTTP 500", "timeout"]) test(generationError + " 立即停止且没有重试", async () => {
  const h = harness({ generationError }); await h.start();
  assert.equal(h.generated, 1); assert.equal(h.timers.size, 0); assert.equal(h.store.getState().gachaMode, false);
});
test("空结果停止", async () => {
  const h = harness({ empty: true }); await h.start(); assert.equal(h.timers.size, 0); assert.equal(h.store.getState().gachaMode, false);
});
test("自动保存失败仍保留历史图片，但不继续", async () => {
  const h = harness({ saveError: true, preferences: { autoSave: true } }); await h.start();
  assert.equal(h.saved, 1); assert.equal(h.timers.size, 0); assert.match(h.store.getState().automaticStopMessage, /保存失败/);
});
test("流末尾报错仍保存已返回图片，不重复计数", async () => {
  const h = harness({ streamError: "broken stream" }); await h.start();
  assert.equal(h.saved, 1); assert.equal(h.store.getState().automaticRun.generated, 1); assert.equal(h.timers.size, 0);
});
for (const config of [{ accountUnavailable: true }, { account: { opusUsage: null } }, { account: { opusUsage: { percent: 0, isNegative: false } } }, { account: { opusUsage: { percent: 10, isNegative: true } } }, { host: "proxy" }]) test("账户未知/额度不足/代理不可验证时不提交：" + JSON.stringify(config), async () => {
  const h = harness(config); await h.start(); assert.equal(h.generated, 0); assert.equal(h.store.getState().gachaMode, false);
});
test("0预算阻止付费；恰好预算可提交，到下一张即停", async () => {
  const blocked = harness({ cost: 5 }); await blocked.start(); assert.equal(blocked.generated, 0);
  const h = harness({ cost: 5, preferences: { gachaAnlasBudget: 5 } }); await h.start(); await h.tick();
  assert.equal(h.generated, 1); assert.match(h.store.getState().automaticStopMessage, /预算/);
});
test("关闭自动继续后旧定时器不会退化成手动生成", async () => {
  const h = harness(); await h.start(); h.prefs({ gachaAutoGenerate: false }); await h.tick(); assert.equal(h.generated, 1);
});
test("修改提示词后不发下一张", async () => {
  const h = harness(); await h.start(); h.store.getState().patchSettings({ scenePrompt: "manual" }); await h.tick();
  assert.equal(h.generated, 1); assert.equal(h.store.getState().settings.scenePrompt, "manual");
});
test("随机抽取期间手动改词不会被覆盖", async () => {
  const h = harness({ onDraw: (h) => h.store.getState().patchSettings({ scenePrompt: "manual" }) }); await h.start();
  assert.equal(h.timers.size, 0); assert.equal(h.store.getState().settings.scenePrompt, "manual");
});
test("账户查询期间停止，不会在查询返回后提交", async () => {
  const h = harness({ onAccount: (h) => { h.store.getState().stopAutomatic("stop"); return h.account; } }); await h.start();
  assert.equal(h.generated, 0);
});
test("生成中停止仍计入本轮已完成图片，但不排下一张", async () => {
  const h = harness({ onGenerate: (h) => h.store.getState().stopAutomatic("stop") }); await h.start();
  assert.equal(h.saved, 1); assert.equal(h.store.getState().automaticRun.generated, 1); assert.equal(h.timers.size, 0);
});
test("设备休眠后不补发", async () => {
  const h = harness(); await h.start(); await h.tick(31000); assert.equal(h.generated, 1); assert.match(h.store.getState().automaticStopMessage, /休眠/);
});
test("重复点击没有并发请求", async () => {
  let release; const pending = new Promise((resolve) => { release = resolve; });
  const h = harness({ onGenerate: () => pending }); const first = h.start(); await h.settle();
  await h.store.getState().generate(); assert.equal(h.generated, 1); release(); await first;
});
test("另一个浏览器页面持有生成锁时不提交", async () => {
  const h = harness({ lockUnavailable: true }); await h.start(); assert.equal(h.generated, 0);
});
test("生成后检测到免费额度耗尽立即停止，不等待再发", async () => {
  const h = harness({ onAccount: (h, call) => call === 1 ? h.account : { ...h.account, opusUsage: { percent: 0, isNegative: true } } });
  await h.start(); assert.equal(h.generated, 1); assert.equal(h.timers.size, 0); assert.match(h.store.getState().automaticStopMessage, /额度耗尽/);
});
test("生成后额度查询失败停止", async () => {
  const h = harness({ onAccount: (h, call) => call === 1 ? h.account : null });
  await h.start(); assert.equal(h.generated, 1); assert.equal(h.timers.size, 0);
});
test("预计免费仍扣点时停止", async () => {
  const h = harness({ onAccount: (h, call) => call === 1 ? h.account : { ...h.account, anlasBalance: 99 } });
  await h.start(); assert.equal(h.generated, 1); assert.equal(h.timers.size, 0); assert.match(h.store.getState().automaticStopMessage, /扣除/);
});
