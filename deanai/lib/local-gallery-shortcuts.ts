import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export type LocalGalleryShortcutAction =
  | "previous"
  | "next"
  | "close"
  | "toggleFavorite"
  | "delete"
  | "copyPrompt"
  | "copyImage"
  | "copyCleanImage"
  | "usePrompt"
  | "useParameters";

export type LocalGalleryShortcuts = Record<LocalGalleryShortcutAction, string>;

export const LOCAL_GALLERY_SHORTCUT_ACTIONS: Array<{ action: LocalGalleryShortcutAction; label: string; hint: string }> = [
  { action: "previous", label: "上一张", hint: "切换到当前页上一张图片" },
  { action: "next", label: "下一张", hint: "切换到当前页下一张图片" },
  { action: "close", label: "关闭详情", hint: "关闭当前图片详情窗口" },
  { action: "toggleFavorite", label: "收藏 / 取消收藏", hint: "切换当前图片的收藏状态" },
  { action: "delete", label: "删除当前图片", hint: "直接移到 Windows 回收站并顺位下一张" },
  { action: "copyPrompt", label: "复制提示词", hint: "复制正向与负向提示词" },
  { action: "copyImage", label: "复制原图", hint: "复制包含原始元数据的图片" },
  { action: "copyCleanImage", label: "复制无元数据图片", hint: "重新编码后复制，适合分享" },
  { action: "usePrompt", label: "仅返回提示词", hint: "把正向提示词送回生图页面待用区域" },
  { action: "useParameters", label: "返回完整参数", hint: "把提示词、种子、采样参数等送回生图页面" },
];

export const DEFAULT_LOCAL_GALLERY_SHORTCUTS: LocalGalleryShortcuts = {
  previous: "ArrowLeft",
  next: "ArrowRight",
  close: "Escape",
  toggleFavorite: "KeyF",
  delete: "Delete",
  copyPrompt: "KeyP",
  copyImage: "KeyC",
  copyCleanImage: "KeyJ",
  usePrompt: "KeyR",
  useParameters: "KeyG",
};

const STORAGE_KEY = "dean-local-gallery-shortcuts-v1";
export const LOCAL_GALLERY_SHORTCUTS_EVENT = "dean-local-gallery-shortcuts-changed";

export function loadLocalGalleryShortcuts(): LocalGalleryShortcuts {
  if (typeof window === "undefined") return { ...DEFAULT_LOCAL_GALLERY_SHORTCUTS };
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}") as Partial<LocalGalleryShortcuts>;
    return Object.fromEntries(
      Object.keys(DEFAULT_LOCAL_GALLERY_SHORTCUTS).map((key) => {
        const action = key as LocalGalleryShortcutAction;
        return [action, typeof saved[action] === "string" ? saved[action] : DEFAULT_LOCAL_GALLERY_SHORTCUTS[action]];
      }),
    ) as LocalGalleryShortcuts;
  } catch {
    return { ...DEFAULT_LOCAL_GALLERY_SHORTCUTS };
  }
}

export function saveLocalGalleryShortcuts(shortcuts: LocalGalleryShortcuts) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
    window.dispatchEvent(new CustomEvent(LOCAL_GALLERY_SHORTCUTS_EVENT, { detail: shortcuts }));
  }
  return shortcuts;
}

export function shortcutFromEvent(event: KeyboardEvent | ReactKeyboardEvent): string {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return "";
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(event.code || event.key);
  return parts.join("+");
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  return shortcutFromEvent(event) === shortcut;
}

export function formatShortcut(shortcut: string): string {
  if (!shortcut) return "未设置";
  return shortcut.split("+").map((part) => {
    if (part.startsWith("Key")) return part.slice(3);
    if (part.startsWith("Digit")) return part.slice(5);
    return ({ ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: "空格" } as Record<string, string>)[part] || part;
  }).join(" + ");
}