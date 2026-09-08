"use client";

import type { AppPreferences } from "@/lib/app-preferences";
import { Input } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";

const fields = [
  ["gachaAutoGenerateIntervalSeconds", "最短间隔（秒）", 5, 3600],
  ["gachaMaxIntervalSeconds", "最长间隔（秒）", 5, 3600],
  ["gachaMaxImages", "本轮最多生成（张）", 1, 1000],
  ["gachaMaxMinutes", "本轮最长运行（分钟）", 1, 1440],
  ["gachaAnlasBudget", "本轮预计 Anlas 预算（0＝仅预计免费）", 0, 100000],
  ["gachaRestEvery", "每生成几张额外休息（0＝关闭）", 0, 1000],
  ["gachaRestSeconds", "额外休息（秒）", 0, 3600],
] as const;

export function AutomaticGenerationSettings({ preferences: p, onChange }: {
  preferences: AppPreferences;
  onChange: (patch: Partial<AppPreferences>) => void;
}) {
  return <section className="mb-5 grid gap-4 rounded-lg border border-border-soft bg-surface-2 p-4">
    <h3 className="text-sm font-semibold">抽卡与自动生成</h3>
    <SwitchRow label="成功后随机下一场景" checked={p.gachaRandomScene} onCheckedChange={(gachaRandomScene) => onChange({ gachaRandomScene })} />
    <SwitchRow label="成功后随机下一画师串" checked={p.gachaRandomArtist} onCheckedChange={(gachaRandomArtist) => onChange({ gachaRandomArtist })} />
    <SwitchRow label="自动继续生成" hint="默认关闭。关闭时只换词，不会提交下一张；开启后也需先在生图页打开抽卡模式，再手动点击生成。" checked={p.gachaAutoGenerate} onCheckedChange={(gachaAutoGenerate) => onChange({ gachaAutoGenerate })} />
    {p.gachaAutoGenerate && <>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([key, label, min, max]) => <label key={key} className="grid gap-1 text-sm">
          <span>{label}</span><Input type="number" min={min} max={max} value={p[key]} onChange={(event) => onChange({ [key]: Number(event.target.value) })} />
        </label>)}
      </div>
      {p.gachaMaxIntervalSeconds < p.gachaAutoGenerateIntervalSeconds && <p className="text-xs text-warn">最长间隔小于最短间隔，保存时会自动提高到最短间隔。</p>}
      <SwitchRow label="程序进入后台时停止自动继续" hint="切换浏览器标签页或手机锁屏时停止。设备休眠造成计时异常也不会补发请求。" checked={p.gachaStopWhenHidden} onCheckedChange={(gachaStopWhenHidden) => onChange({ gachaStopWhenHidden })} />
      <p className="text-xs leading-relaxed text-muted">间隔从上一张完成后计算，独立于基础重试延迟；每轮仅一张，不改变手动生成的批量设置。支持范围波动与周期性休息，不能保证规避风控。张数、时长、预计预算任一触顶即停；429 等任何生成错误、空结果、自动保存失败、额度无法校验或 V5 免费额度耗尽均停止，不重试、不自动转付费、不在重启后续跑。</p>
      <p className="text-xs text-warn">Anlas 预算是本地估算保护，并非官方扣费上限；实际计费以官方为准。建议开启自动保存。修改参数或抽卡设置后需要重新开始。种子仍遵循生图设置（-1 为随机）。</p>
    </>}
    <p className="text-xs text-muted">随机目录、预设和权重沿用下方设置。两个随机开关都关闭时，自动模式重复使用当前提示词。</p>
  </section>;
}
