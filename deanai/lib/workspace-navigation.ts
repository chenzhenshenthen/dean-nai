export type WorkspaceView =
  | "studio"
  | "local-gallery"
  | "online-gallery"
  | "library"
  | "external-library"
  | "stats"
  | "vocabulary"
  | "settings";

export const WORKSPACE_NAVIGATE_EVENT = "dean-nai:workspace-navigate";

export type WorkspaceNavigateDetail = {
  view: WorkspaceView;
  url?: string;
};

export function navigateDesktopWorkspace(view: WorkspaceView, url?: string): boolean {
  if (process.env.NEXT_PUBLIC_LOCAL_DESKTOP !== "1" || typeof window === "undefined") return false;
  window.dispatchEvent(new CustomEvent<WorkspaceNavigateDetail>(WORKSPACE_NAVIGATE_EVENT, {
    detail: { view, url },
  }));
  return true;
}
