"use client";

import { Gem, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Host } from "nekoai-js";
import { useStore } from "@/lib/store";
import { estimateV5RemainingImages, remainingOpusPercent, V5_FULL_BATTERY_IMAGES } from "@/lib/account-usage";

function RefreshButton({ busy, disabled, onClick, label }: { busy: boolean; disabled: boolean; onClick: () => void; label: string }) {
  return <button type="button" disabled={busy || disabled} onClick={onClick} aria-label={label} className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50"><RefreshCw className={"size-3.5 " + (busy ? "animate-spin" : "")} />{busy ? "查询中" : "刷新"}</button>;
}

export function AccountStatusPanel() {
  const [copyStatus, setCopyStatus] = useState("");
  const account = useStore((s) => s.accountStatus);
  const balance = useStore((s) => s.anlasBalance);
  const error = useStore((s) => s.accountError);
  const busy = useStore((s) => s.accountRefreshing);
  const quota = useStore((s) => s.v5Quota);
  const quotaError = useStore((s) => s.v5QuotaError);
  const quotaBusy = useStore((s) => s.v5QuotaRefreshing);
  const connection = useStore((s) => s.connection);
  const refresh = useStore((s) => s.refreshAnlas);
  const refreshQuota = useStore((s) => s.refreshV5Quota);
  const supported = connection?.host === Host.WEB;
  const blocked = [error, quotaError].some((value) => value?.includes("Cloudflare 1010"));
  const diagnostics = ["deanai 额度查询诊断", "接口：https://image.novelai.net/user/subscription",
    "客户端路径：" + (process.env.NEXT_PUBLIC_STATIC_PWA === "1" ? "静态客户端直连" : "本地后端代理"),
    ...Array.from(new Set([error, quotaError].filter(Boolean)))].join("\n");
  async function copyDiagnostics() {
    try { await navigator.clipboard.writeText(diagnostics); setCopyStatus("已复制诊断信息"); }
    catch { setCopyStatus("无法自动复制，请在下方文本框中手动选择复制"); }
  }
  const percent = remainingOpusPercent(quota?.opusUsage);
  const estimatedImages = quota?.active && quota.tier === 3 ? estimateV5RemainingImages(quota.opusUsage) : null;
  const refreshed = (time?: number) => time ? new Date(time).toLocaleString() : "尚未查询成功";
  return <section className="grid gap-3 rounded-xl border border-border-soft bg-surface p-4 text-sm shadow-lg" aria-label="账户余额与免费额度">
    <div className="flex items-center justify-between gap-3"><strong>账户余额与额度</strong><button type="button" disabled={!supported || blocked || (busy && quotaBusy)} onClick={() => { void refresh(); void refreshQuota(); }} className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50">全部刷新</button></div>
    <section className="grid gap-2 rounded-lg border border-border-soft p-3" aria-label="Anlas 点数查询">
      <div className="flex items-center justify-between gap-2"><span>剩余 Anlas <strong className="ml-1 text-lg tabular-nums">{balance === null ? "未知" : balance.toLocaleString()}</strong></span><RefreshButton busy={busy} disabled={!supported || blocked} onClick={() => void refresh()} label="仅刷新 Anlas 点数" /></div>
      {account && <p className="text-xs text-muted">{account.tierName} · {account.active ? "订阅有效" : "订阅未激活"}<br />订阅点数 {account.fixedAnlas.toLocaleString()} / 购买点数 {account.purchasedAnlas.toLocaleString()}</p>}
      {account?.expiresAt && <p className="text-xs text-muted">订阅到期：{new Date(account.expiresAt * 1000).toLocaleString()}</p>}
      <p className="text-xs text-muted">更新时间：{refreshed(account?.refreshedAt)}</p>
      {error && <p role="status" className="break-words text-xs text-danger">{error}{account && "；上方为旧数据，仅供参考。"}</p>}
    </section>
    <section className="grid gap-2 rounded-lg border border-border-soft p-3" aria-label="V5 免费额度查询">
      <div className="flex items-center justify-between gap-2"><span>V5 免费额度 <strong className="ml-1 tabular-nums">{!quota ? "未知" : !quota.active || quota.tier !== 3 ? "不适用" : percent === null ? "未知" : percent.toLocaleString(undefined, { maximumFractionDigits: 2 }) + "%"}</strong></span><RefreshButton busy={quotaBusy} disabled={!supported || blocked} onClick={() => void refreshQuota()} label="仅刷新 V5 免费额度" /></div>
      {quota?.active && quota.tier === 3 && percent !== null && <>
        <progress aria-label="V5 剩余免费额度" max={100} value={Math.min(100, percent)} className="h-2 w-full accent-[var(--accent)]" />
        <div className="grid gap-1.5 rounded-md bg-surface-2 p-2.5">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><span className="text-xs text-muted">预估剩余免费生图</span><strong className="tabular-nums">{estimatedImages === null ? "无法估算" : "约 " + estimatedImages.toLocaleString() + " 张"}</strong></p>
          <p className="text-xs leading-relaxed text-muted">按满额约 {V5_FULL_BATTERY_IMAGES.toLocaleString()} 张 × 剩余百分比估算。参考：1024×1024、28 步、每次 1 张。</p>
          <p className="text-xs leading-relaxed text-muted">非官方保证值，未按当前生图参数换算；实际消耗随分辨率、步数变化。不含 Anlas 付费生成，也未计入后续恢复。</p>
          {percent > 100 && <p className="text-xs text-muted">接口百分比超过 100%，按实际返回值估算。</p>}
        </div>
        {quota.opusUsage?.isNegative && <p className="text-xs text-muted">额度已透支；自动模式不会转为付费继续。</p>}
      </>}
      <p className="text-xs text-muted">更新时间：{refreshed(quota?.refreshedAt)}</p>
      {quotaError && <p role="status" className="break-words text-xs text-danger">{quotaError}{quota && "；上方为旧数据，仅供参考。"}</p>}
    </section>
    <p className="text-xs text-muted">两项独立显示、独立报错；同时刷新合并为一次订阅请求。未知不等于 0 或无限。</p>
    {blocked && <p className="text-xs text-danger">已暂停本次会话的额度请求。请联系 NovelAI 确认客户端访问限制；不必更换 Token 或反复点击刷新。</p>}
    {(error || quotaError) && <details className="text-xs"><summary className="cursor-pointer">脱敏诊断信息</summary><div className="mt-2 grid gap-2"><textarea readOnly value={diagnostics} aria-label="可复制的脱敏额度诊断" className="min-h-36 w-full resize-y rounded border border-border bg-surface-2 p-2" /><button type="button" onClick={() => void copyDiagnostics()} className="rounded border border-border px-2 py-1">复制诊断信息</button>{copyStatus && <p role="status">{copyStatus}</p>}</div></details>}
    {!connection ? <p className="text-xs text-muted">请先连接 NovelAI 账户。</p> : !supported && <p className="text-xs text-muted">当前第三方连接不支持官网额度查询。</p>}
  </section>;
}

export function AccountStatusMenu() {
  const balance = useStore((s) => s.anlasBalance);
  const quota = useStore((s) => s.v5Quota);
  const percent = remainingOpusPercent(quota?.opusUsage);
  const refresh = useStore((s) => s.refreshAnlas);
  const refreshQuota = useStore((s) => s.refreshV5Quota);
  return <details className="group relative" onToggle={(event) => { if (event.currentTarget.open) { void refresh(); void refreshQuota(); } }}>
    <summary className="flex h-9 cursor-pointer list-none items-center gap-1 rounded-full border border-border-soft bg-surface-2 px-2 text-xs font-semibold [&::-webkit-details-marker]:hidden" title="查看账户 Anlas 和 V5 免费额度" aria-label="查看账户余额与免费额度">
      <Gem className="size-3.5 shrink-0" /><span className="tabular-nums">{balance === null ? "额度" : balance.toLocaleString()}</span>
      <span className="hidden border-l border-border pl-1.5 text-muted lg:inline">V5 {quota?.active && quota.tier === 3 && percent !== null ? percent.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%" : "—"}</span>
    </summary>
    <div className="fixed inset-x-2 top-16 z-50 max-h-[75dvh] overflow-y-auto overscroll-contain sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-80"><AccountStatusPanel /></div>
  </details>;
}
