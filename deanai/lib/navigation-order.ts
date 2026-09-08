import type { WorkspaceView } from "@/lib/workspace-navigation";

export const NAV_ORDER_KEY = "dean-nai-navigation-order-v1";
export const NAV_EDIT_EVENT = "dean-nai-navigation-edit-mode";
export const NAV_RESET_EVENT = "dean-nai-navigation-reset";

export const DEFAULT_NAV_ORDER: WorkspaceView[] = [
  "studio",
  "local-gallery",
  "online-gallery",
  "external-library",
  "vocabulary",
  "library",
  "stats",
  "settings",
];

export function normalizedNavOrder(value: unknown): WorkspaceView[] {
  const known = new Set(DEFAULT_NAV_ORDER);
  const saved = Array.isArray(value)
    ? value.filter((item): item is WorkspaceView => typeof item === "string" && known.has(item as WorkspaceView))
    : [];
  return [...new Set([...saved, ...DEFAULT_NAV_ORDER])];
}

export function setNavigationEditMode(enabled: boolean) {
  window.dispatchEvent(new CustomEvent<boolean>(NAV_EDIT_EVENT, { detail: enabled }));
}

export function resetNavigationOrder() {
  window.localStorage.removeItem(NAV_ORDER_KEY);
  window.dispatchEvent(new Event(NAV_RESET_EVENT));
}
