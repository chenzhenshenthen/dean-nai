"use client";

import { useEffect, useRef, useState } from "react";

const LIBRARY_STYLE = "/static/styles.css?v=2026.09.05.1";
const CONVERTER_STYLE = "/static/converter.css?v=2026.09.01.1";
const LIBRARY_SCRIPT = "/static/app.js?v=2026.09.01.1";
const CONVERTER_SCRIPT = "/static/converter.js?v=2026.09.01.1";
const LIBRARY_SCROLL_KEY = "deanai-native-library-scroll-v1";

const EMBED_OVERRIDES = `
:host {
  display: block;
  position: relative;
  width: 100%;
  height: 100dvh;
  min-height: 640px;
  overflow: hidden;
  transform: translateZ(0);
  background: var(--bg, #080b12);
}
body { width: 100%; height: 100%; min-width: 0; overflow: auto; overscroll-behavior: contain; padding-left: 0 !important; }
.global-app-nav { display: none !important; }
.sidebar { left: 0; }
.topbar { left: 284px; }
.sidebar-reopen { left: 12px; }
body[data-sidebar-dock="left"] .sidebar { left: 0; }
body[data-sidebar-dock="left"] .topbar { left: calc(24px + var(--directory-panel-size)); }
body[data-sidebar-dock="right"] .topbar { left: 24px; }
body[data-sidebar-dock="top"] .sidebar,
body[data-sidebar-dock="bottom"] .sidebar { left: 0; }
body[data-sidebar-dock="top"] .topbar,
body[data-sidebar-dock="bottom"] .topbar { left: 24px; }
body[data-sidebar-dock="floating"] .topbar,
body[data-sidebar-collapsed="true"] .topbar { left: 24px; }
`;

function appendScript(root: ShadowRoot, source: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`无法加载资料库脚本：${source}`));
    root.append(script);
  });
}

function loadSavedScroll() {
  if (typeof window === "undefined") return 0;
  const value = Number(window.localStorage.getItem(LIBRARY_SCROLL_KEY));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function NativeLibraryWorkspace({ url, active }: { url: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  const scrollRef = useRef(0);
  const [error, setError] = useState("");

  activeRef.current = active;

  useEffect(() => {
    if (!active) return;
    const restore = () => {
      const body = hostRef.current?.shadowRoot?.querySelector("body");
      if (body) body.scrollTop = scrollRef.current || loadSavedScroll();
    };
    const frame = window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(restore);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.dataset.libraryUrl = url || "/library-embed/";
    host.dispatchEvent(new CustomEvent("dean-nai:library-url"));
  }, [url]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || host.shadowRoot) return;
    let cancelled = false;
    void (async () => {
      try {
        const [html, libraryCss, converterCss] = await Promise.all([
          fetch("/library-embed/", { cache: "no-store" }).then((response) => response.text()),
          fetch(LIBRARY_STYLE, { cache: "no-store" }).then((response) => response.text()),
          fetch(CONVERTER_STYLE, { cache: "no-store" }).then((response) => response.text()),
        ]);
        if (cancelled) return;
        const parsed = new DOMParser().parseFromString(html, "text/html");
        parsed.body.querySelectorAll("script,.global-app-nav").forEach((node) => node.remove());
        const root = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = `${libraryCss.replace(/^\s*:root\s*\{/, ":host {")}\n${converterCss}\n${EMBED_OVERRIDES}`;
        const body = document.createElement("body");
        body.className = parsed.body.className;
        body.innerHTML = parsed.body.innerHTML;
        scrollRef.current = loadSavedScroll();
        body.addEventListener("scroll", () => {
          if (!activeRef.current) return;
          scrollRef.current = body.scrollTop;
          window.localStorage.setItem(LIBRARY_SCROLL_KEY, String(body.scrollTop));
        }, { passive: true });
        root.append(style, body);
        await appendScript(root, LIBRARY_SCRIPT);
        await appendScript(root, CONVERTER_SCRIPT);
        window.requestAnimationFrame(() => { body.scrollTop = scrollRef.current; });
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div ref={hostRef} data-dean-library-host data-library-url={url} className="h-dvh w-full bg-bg">
      {error && <div className="p-8 text-sm text-danger">资料库加载失败：{error}</div>}
    </div>
  );
}
