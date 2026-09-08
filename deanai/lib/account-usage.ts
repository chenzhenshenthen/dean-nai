export type OpusUsage = { percent: number; isNegative: boolean; timeUntilNextPercent: number };

export function parseOpusUsage(value: unknown): OpusUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Partial<OpusUsage>;
  // Missing/invalid fields mean unknown, never an invented 0% or free allowance.
  if (typeof usage.percent !== "number" || !Number.isFinite(usage.percent) || typeof usage.isNegative !== "boolean") return null;
  return {
    percent: usage.percent,
    isNegative: usage.isNegative,
    timeUntilNextPercent: typeof usage.timeUntilNextPercent === "number" && Number.isFinite(usage.timeUntilNextPercent)
      ? Math.max(0, usage.timeUntilNextPercent) : 0,
  };
}

export function remainingOpusPercent(usage: OpusUsage | null | undefined): number | null {
  if (!usage || !Number.isFinite(usage.percent)) return null;
  return usage.isNegative ? 0 : Math.max(0, usage.percent);
}

// User-provided nai_balance_check_v5.py reference, NOT an official allowance.
// Display only: never use this estimate to authorize automatic/paid generation.
export const V5_FULL_BATTERY_IMAGES = 1700;

export function estimateV5RemainingImages(usage: OpusUsage | null | undefined): number | null {
  const percent = remainingOpusPercent(usage);
  if (percent === null) return null;
  const estimate = Math.round(V5_FULL_BATTERY_IMAGES * percent / 100);
  return Number.isSafeInteger(estimate) ? estimate : null;
}
