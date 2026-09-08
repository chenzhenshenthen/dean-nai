"use client";

import { useEffect, useMemo, useState } from "react";
import { FolderTree, Plus, Save, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { RandomDirectoryPreset, RandomKindPreferences } from "@/lib/random-library";
import { getMobileNavigation } from "@/lib/db/mobile-library";

type Category = { name: string; count: number };
type Props = {
  kind: "artist" | "prompt";
  value: RandomKindPreferences;
  presets: RandomDirectoryPreset[];
  onChange: (patch: Partial<RandomKindPreferences>) => void;
  onPresetsChange: (presets: RandomDirectoryPreset[]) => void;
};

function leafName(path: string) {
  return path.split("/").filter(Boolean).at(-1) || path;
}
export function RandomDirectorySelector({ kind, value, presets, onChange, onPresetsChange }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [presetName, setPresetName] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const navigation = process.env.NEXT_PUBLIC_STATIC_PWA === "1"
      ? getMobileNavigation()
      : fetch("/api/library/navigation").then(async (response) => {
        if (!response.ok) throw new Error("目录读取失败");
        return response.json() as Promise<{ categories?: Record<string, Category[]> }>;
      });
    void navigation
      .then((data) => {
        if (!cancelled) setCategories(data.categories?.[kind] || []);
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [kind]);

  useEffect(() => {
    const preset = presets.find((item) => item.id === value.presetId);
    setPresetName(preset?.name || "");
  }, [presets, value.presetId]);

  const expandedSelected = useMemo(() => {
    const next = new Set<string>();
    for (const selectedPath of value.categories) {
      for (const category of categories) {
        if (category.name === selectedPath || category.name.startsWith(selectedPath + "/")) {
          next.add(category.name);
        }
      }
    }
    return next;
  }, [categories, value.categories]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? categories.filter((item) => item.name.toLocaleLowerCase().includes(needle))
      : categories;
  }, [categories, query]);

  const toggle = (path: string) => {
    const branch = categories
      .map((item) => item.name)
      .filter((category) => category === path || category.startsWith(path + "/"));
    const next = new Set(expandedSelected);
    const branchSelected = branch.length > 0 && branch.every((category) => next.has(category));
    if (branchSelected) {
      branch.forEach((category) => next.delete(category));
      const parts = path.split("/").filter(Boolean);
      for (let depth = 1; depth < parts.length; depth += 1) {
        next.delete(parts.slice(0, depth).join("/"));
      }
    } else {
      branch.forEach((category) => next.add(category));
    }
    onChange({ categories: [...next] });
  };

  const loadPreset = (id: string) => {
    if (!id) {
      onChange({ presetId: "" });
      setPresetName("");
      return;
    }
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    onChange({ presetId: id, categories: preset.categories });
    setPresetName(preset.name);
  };

  const createPreset = () => {
    const name = presetName.trim();
    if (!name) { toast.error("请先填写预设名称。"); return; }
    if (!value.categories.length) { toast.error("请先选择至少一个目录。"); return; }
    const id = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `preset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    onPresetsChange([...presets, { id, name, categories: value.categories }]);
    onChange({ presetId: id });
    toast.success("已保存新预设。");
  };

  const updatePreset = () => {
    if (!value.presetId) { toast.info("请先选择要修改的预设。"); return; }
    const name = presetName.trim();
    if (!name) { toast.error("预设名称不能为空。"); return; }
    if (!value.categories.length) { toast.error("预设至少需要一个目录。"); return; }
    onPresetsChange(presets.map((item) => item.id === value.presetId
      ? { ...item, name, categories: value.categories }
      : item));
    toast.success("预设已更新。");
  };

  const deletePreset = () => {
    if (!value.presetId) return;
    onPresetsChange(presets.filter((item) => item.id !== value.presetId));
    onChange({ presetId: "" });
    setPresetName("");
    toast.success("预设已删除，当前目录选择仍然保留。");
  };

  return <div className="mt-3 rounded-lg border border-border-soft bg-surface p-3">
    <div className="grid gap-2 md:grid-cols-[minmax(150px,220px)_minmax(160px,1fr)_auto]">
      <Select value={value.presetId} onChange={(event) => loadPreset(event.target.value)} aria-label="目录预设">
        <option value="">自定义选择（未保存）</option>
        {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} · {preset.categories.length} 项</option>)}
      </Select>
      <Input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="预设名称" />
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" variant="outline" onClick={createPreset}><Plus />新增</Button>
        <Button type="button" size="sm" variant="outline" disabled={!value.presetId} onClick={updatePreset}><Save />保存修改</Button>
        <Button type="button" size="sm" variant="outline" disabled={!value.presetId} onClick={deletePreset} aria-label="删除预设"><Trash2 /></Button>
      </div>
    </div>

    <div className="mt-3 flex flex-wrap items-center gap-2">
      <label className="relative min-w-48 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索目录" />
      </label>
      <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ categories: categories.map((item) => item.name) })}>全选</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ categories: [] })}>清空</Button>
      <span className="text-xs text-muted">已选 {expandedSelected.size} 项</span>
    </div>

    <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-border-soft bg-surface-2 p-1.5">
      {loading ? <p className="p-3 text-sm text-muted">正在读取目录…</p> : visible.length ? visible.map((item) => {
        const depth = Math.max(0, item.name.split("/").filter(Boolean).length - 1);
        const branch = categories
          .map((category) => category.name)
          .filter((category) => category === item.name || category.startsWith(item.name + "/"));
        const allSelected = branch.length > 0 && branch.every((category) => expandedSelected.has(category));
        const partiallySelected = !allSelected && branch.some((category) => expandedSelected.has(category));
        return <label key={item.name} className="flex cursor-pointer items-center gap-2 rounded-md py-2 pr-2 text-sm hover:bg-surface-3" style={{ paddingLeft: `${10 + depth * 18}px` }} title={item.name}>
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={allSelected}
            ref={(element) => { if (element) element.indeterminate = partiallySelected; }}
            onChange={() => toggle(item.name)}
          />
          <FolderTree className="size-3.5 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">{leafName(item.name)}</span>
          <span className="text-xs tabular-nums text-muted">{item.count}</span>
        </label>;
      }) : <p className="p-3 text-sm text-muted">{query ? "没有匹配目录。" : "没有读取到目录，请确认资料库服务已启动。"}</p>}
    </div>
    <p className="mt-2 text-xs text-muted">勾选父目录会同步勾选全部子目录；取消某个子目录后，父目录会显示为半选并排除该子树。</p>
  </div>;
}
