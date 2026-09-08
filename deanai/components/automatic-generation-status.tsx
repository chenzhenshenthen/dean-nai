"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";

export function AutomaticGenerationStatus() {
  const run = useStore((s) => s.automaticRun);
  const enabled = useStore((s) => s.gachaMode);
  const reason = useStore((s) => s.automaticStopMessage);
  const generating = useStore((s) => s.isGenerating);
  const stop = useStore((s) => s.stopAutomatic);
  const [now, setNow] = useState(0);
  const running = Boolean(run) && enabled;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!run && !reason) return null;
  const remaining = run?.nextAt ? Math.max(0, Math.ceil((run.nextAt - (now || run.startedAt)) / 1000)) : null;
  return <div className="mt-2 rounded-lg border border-border-soft bg-surface-2 p-3 text-xs leading-relaxed">
    {run && <p>本轮 {run.generated} / {run.policy.gachaMaxImages} 张 · 预计 {run.estimatedSpent} / {run.policy.gachaAnlasBudget} Anlas</p>}
    <p className="text-muted">{enabled ? generating ? "正在生成；停止自动继续不会丢弃已提交的图片" : remaining !== null ? "下一张约 " + remaining + " 秒后（含额外休息）" : "正在检查额度或准备下一张…" : reason}</p>
    {enabled && run && <button type="button" onClick={() => stop("已手动停止自动继续")} className="mt-2 rounded-md border border-border px-2 py-1 text-fg hover:bg-surface-3">停止自动继续</button>}
  </div>;
}
