"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3, BookOpen, Database, GripVertical, Images, Search, Settings2, Sparkles, Tags } from "lucide-react";
import { DEFAULT_NAV_ORDER, NAV_EDIT_EVENT, NAV_ORDER_KEY, NAV_RESET_EVENT, normalizedNavOrder } from "@/lib/navigation-order";
import { cn } from "@/lib/utils";
import type { WorkspaceView } from "@/lib/workspace-navigation";

const defaultItems: Array<{ view: WorkspaceView; label: string; icon: typeof Sparkles }> = [
  { view: "studio", label: "生图", icon: Sparkles },
  { view: "local-gallery", label: "本地画廊", icon: Images },
  { view: "online-gallery", label: "在线画廊", icon: Search },
  { view: "external-library", label: "外置资料库", icon: Database },
  { view: "vocabulary", label: "标签词库", icon: Tags },
  { view: "library", label: "本地资料库", icon: BookOpen },
  { view: "stats", label: "统计", icon: BarChart3 },
  { view: "settings", label: "设置", icon: Settings2 },
];

export function AppNav({
  current,
  onNavigate,
}: {
  current: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
}) {
  const [order, setOrder] = useState<WorkspaceView[]>(DEFAULT_NAV_ORDER);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<WorkspaceView | null>(null);
  const itemMap = useMemo(() => new Map(defaultItems.map((item) => [item.view, item])), []);
  const items = order.map((view) => itemMap.get(view)).filter((item): item is (typeof defaultItems)[number] => Boolean(item));

  useEffect(() => {
    const loadOrder = () => {
      try { setOrder(normalizedNavOrder(JSON.parse(window.localStorage.getItem(NAV_ORDER_KEY) || "[]"))); }
      catch { setOrder(DEFAULT_NAV_ORDER); }
    };
    const handleEdit = (event: Event) => setEditing(Boolean((event as CustomEvent<boolean>).detail));
    loadOrder();
    window.addEventListener(NAV_EDIT_EVENT, handleEdit);
    window.addEventListener(NAV_RESET_EVENT, loadOrder);
    return () => {
      window.removeEventListener(NAV_EDIT_EVENT, handleEdit);
      window.removeEventListener(NAV_RESET_EVENT, loadOrder);
    };
  }, []);

  useEffect(() => {
    if (current !== "settings") {
      setEditing(false);
      setDragging(null);
      window.dispatchEvent(new CustomEvent<boolean>(NAV_EDIT_EVENT, { detail: false }));
    }
  }, [current]);

  const saveOrder = (next: WorkspaceView[]) => {
    setOrder(next);
    window.localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(next));
  };
  const moveBefore = (target: WorkspaceView) => {
    if (!dragging || dragging === target) return;
    const targetIndex = order.indexOf(target);
    const next = order.filter((view) => view !== dragging);
    next.splice(targetIndex, 0, dragging);
    saveOrder(next);
  };

  return (
    <nav className="fixed inset-y-0 left-0 z-50 flex w-16 flex-col items-center gap-2 border-r border-border-soft bg-surface/95 px-2 py-4 shadow-[var(--shadow-panel)] backdrop-blur-xl">
      <button type="button" onClick={() => onNavigate("studio")} title="dean-nai" className="mb-3 flex size-10 items-center justify-center rounded-xl bg-accent/15 text-sm font-black text-accent">D</button>
      {items.map(({ view, label, icon: Icon }) => (
        <button
          key={view}
          type="button"
          draggable={editing}
          onDragStart={(event) => { if (!editing) return; setDragging(view); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnter={() => { if (editing) moveBefore(view); }}
          onDragOver={(event) => { if (!editing) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
          onDragEnd={() => setDragging(null)}
          onClick={() => { if (!editing) onNavigate(view); }}
          title={editing ? label + "（拖动调整顺序）" : label}
          aria-label={label}
          className={cn(
            "group relative flex size-10 shrink-0 items-center justify-center rounded-lg text-muted transition-[color,background-color,opacity] hover:bg-surface-3 hover:text-fg",
            editing && "cursor-grab ring-1 ring-accent/25 active:cursor-grabbing",
            current === view && "bg-accent/15 text-accent",
            dragging === view && "opacity-40",
          )}
        >
          <Icon className="size-4" />
          {editing && <GripVertical className="absolute -right-1 size-3 text-accent" />}
          <span className="sr-only">{label}</span>
        </button>
      ))}
      {editing && <span className="mt-auto text-center text-[9px] leading-tight text-accent">拖动<br />排序</span>}
    </nav>
  );
}