import type { AppPreferences } from "./app-preferences";

export type AutomaticRun = {
  id: number;
  startedAt: number;
  generated: number;
  estimatedSpent: number;
  nextAt: number | null;
  policy: AppPreferences;
};

/** Estimates are a local spending guard, not a server-enforced billing cap. */
export function automaticStopReason(run: AutomaticRun, now: number, nextCost = 0): string | null {
  if (now < run.startedAt) return "系统时间发生变化，请手动重新开始";
  if (run.generated >= run.policy.gachaMaxImages) return "已达到本轮生成张数上限";
  if (now - run.startedAt >= run.policy.gachaMaxMinutes * 60_000) return "已达到本轮运行时长上限";
  if (!Number.isFinite(nextCost) || nextCost < 0) return "无法估算下一张图片的消耗";
  if (run.estimatedSpent + nextCost > run.policy.gachaAnlasBudget) return "下一张将超过本轮预计 Anlas 预算";
  return null;
}

export function automaticDelayMs(run: AutomaticRun, random = Math.random()): number {
  const p = run.policy;
  const min = p.gachaAutoGenerateIntervalSeconds;
  const max = Math.max(min, p.gachaMaxIntervalSeconds);
  const interval = min + (max - min) * Math.max(0, Math.min(1, random));
  const rest = p.gachaRestEvery > 0 && run.generated > 0 && run.generated % p.gachaRestEvery === 0
    ? p.gachaRestSeconds : 0;
  return Math.ceil((Math.max(interval, p.generationIntervalSeconds) + rest) * 1000);
}

export function automaticPolicyKey(p: AppPreferences): string {
  return JSON.stringify(Object.entries(p).filter(([key]) => key.startsWith("gacha") || ["generationIntervalSeconds", "autoSave", "saveDirectory"].includes(key)));
}
