"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Input, focusRing } from "@/components/ui/input";
import {
  applyAccentSlot,
  currentAccentSlots,
  currentActiveAccentSlot,
  loadPersistedAccentSlots,
  normalizeHexColor,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

export function AccentPicker({ compact = false }: { compact?: boolean }) {
  const [slots, setSlots] = useState<string[]>(["#f35f52", "#4775d1", "#d9469d", "#8d43d4", "#2f9b75"]);
  const [active, setActive] = useState(0);
  const [draft, setDraft] = useState("#f35f52");

  useEffect(() => {
    const sync = () => {
      const savedSlots = currentAccentSlots();
      const savedActive = currentActiveAccentSlot();
      setSlots(savedSlots);
      setActive(savedActive);
      setDraft(savedSlots[savedActive]);
    };
    sync();
    window.addEventListener("nya-theme-change", sync);
    void loadPersistedAccentSlots().then(({ slots: savedSlots, active: savedActive }) => {
      if (!applyAccentSlot(savedActive, savedSlots, false)) return;
      setSlots(savedSlots);
      setActive(savedActive);
      setDraft(savedSlots[savedActive]);
    }).catch(() => undefined);
    return () => window.removeEventListener("nya-theme-change", sync);
  }, []);

  const chooseSlot = (index: number) => {
    setActive(index);
    setDraft(slots[index]);
    applyAccentSlot(index, slots);
  };

  const updateActiveColor = (value: string) => {
    setDraft(value);
    const normalized = normalizeHexColor(value);
    if (normalized) {
      const next = slots.map((color, index) => index === active ? normalized : color);
      setSlots(next);
      setDraft(normalized);
      applyAccentSlot(active, next);
    }
  };

  return (
    <div className={cn("grid gap-2", compact ? "min-w-0" : "max-w-md")}>
      <div className="flex gap-2">
        {slots.map((color, index) => {
          const selected = active === index;
          return (
            <label
              key={index}
              title={index < 3 ? "\u9884\u8bbe\u8272 " + (index + 1) : "\u81ea\u5b9a\u4e49\u8272 " + (index - 2)}
              onPointerDown={() => chooseSlot(index)}
              className={cn("flex size-10 cursor-pointer items-center justify-center rounded-[9px] border transition-transform hover:scale-105", focusRing, selected ? "border-fg bg-surface-2" : "border-border-soft")}
            >
              <input className="sr-only" type="color" value={color} onChange={(event) => updateActiveColor(event.target.value)} />
              <span className="flex size-6 items-center justify-center rounded-full" style={{ background: color }}>
                {selected && <Check className="size-3.5 text-white drop-shadow" strokeWidth={3} />}
              </span>
            </label>
          );
        })}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Input value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => updateActiveColor(draft)} onKeyDown={(event) => { if (event.key === "Enter") updateActiveColor(draft); }} aria-label="Custom accent hex color" placeholder="#f35f52" className="h-10 min-w-0 font-mono uppercase" />
      </div>
      {!compact && <p className="text-xs text-muted">{"\u524d\u4e09\u683c\u4e3a\u9884\u8bbe\u8272\uff0c\u540e\u4e24\u683c\u4e3a\u81ea\u5b9a\u4e49\u8272\uff1b\u4e94\u683c\u90fd\u53ef\u70b9\u51fb\u4fee\u6539\u3002"}</p>}
    </div>
  );
}
