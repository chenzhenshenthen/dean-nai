"use client";

import { useCallback, useEffect, useState } from "react";
import { AppNav } from "@/components/app-nav";
import { Studio } from "@/components/studio";
import { LocalGallery } from "@/components/local-gallery";
import { OnlineGallery } from "@/components/online-gallery";
import { IntegratedSettings } from "@/components/integrated-settings";
import { GenerationStats } from "@/components/generation-stats";
import { ExternalLibrary } from "@/components/external-library";
import { VocabularyBrowser } from "@/components/vocabulary-browser";
import { NativeLibraryWorkspace } from "@/components/native-library-workspace";
import {
  WORKSPACE_NAVIGATE_EVENT,
  type WorkspaceNavigateDetail,
  type WorkspaceView,
} from "@/lib/workspace-navigation";

const ROUTE_VIEW: Record<string, WorkspaceView> = {
  "/external-library/": "external-library",
  "/": "studio",
  "/vocabulary/": "vocabulary",
  "/local-gallery/": "local-gallery",
  "/online-gallery/": "online-gallery",
  "/library": "library",
  "/library/": "library",
  "/stats/": "stats",
  "/settings/": "settings",
};

function viewFromPath(pathname: string): WorkspaceView {
  const normalized = pathname === "/" ? "/" : pathname.replace(/\/$/, "") + "/";
  return ROUTE_VIEW[normalized] || ROUTE_VIEW[pathname] || "studio";
}

function Pane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <section className={active ? "block min-h-dvh" : "hidden"} aria-hidden={!active} inert={!active}>
      {children}
    </section>
  );
}

export function DesktopWorkspace() {
  const [active, setActive] = useState<WorkspaceView>("studio");
  const [mounted, setMounted] = useState<WorkspaceView[]>(["studio"]);
  const [libraryUrl, setLibraryUrl] = useState("/library-embed/");

  const activate = useCallback((view: WorkspaceView, url?: string) => {
    setMounted((current) => current.includes(view) ? current : [...current, view]);
    if (view === "library" && url) setLibraryUrl(url);
    setActive(view);
    window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }, []);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("workspace") as WorkspaceView | null;
    const initial = requested && ["studio", "local-gallery", "online-gallery", "external-library", "library", "vocabulary", "stats", "settings"].includes(requested)
      ? requested
      : viewFromPath(window.location.pathname);
    queueMicrotask(() => activate(
      initial,
      initial === "library" ? window.location.pathname + window.location.search : undefined,
    ));
    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceNavigateDetail>).detail;
      if (detail?.view) activate(detail.view, detail.url);
    };
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, onNavigate);
  }, [activate]);

  return (
    <>
      <AppNav current={active} onNavigate={activate} />
      <Pane active={active === "studio"}><Studio /></Pane>
      {mounted.includes("local-gallery") && <Pane active={active === "local-gallery"}><LocalGallery /></Pane>}
      {mounted.includes("online-gallery") && <Pane active={active === "online-gallery"}><OnlineGallery /></Pane>}
      {mounted.includes("external-library") && <Pane active={active === "external-library"}><ExternalLibrary /></Pane>}
      {mounted.includes("vocabulary") && <Pane active={active === "vocabulary"}><VocabularyBrowser /></Pane>}
      {mounted.includes("stats") && <Pane active={active === "stats"}><GenerationStats active={active === "stats"} /></Pane>}
      {mounted.includes("settings") && <Pane active={active === "settings"}><IntegratedSettings /></Pane>}
      {mounted.includes("library") && (
        <Pane active={active === "library"}>
          <NativeLibraryWorkspace url={libraryUrl} active={active === "library"} />
        </Pane>
      )}
    </>
  );
}
