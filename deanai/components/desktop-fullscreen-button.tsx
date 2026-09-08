"use client";

import { useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";

type DesktopBridge = { toggle_fullscreen?: () => Promise<boolean> };

export function DesktopFullscreenButton() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const check = () => setAvailable(Boolean((window as typeof window & { pywebview?: { api?: DesktopBridge } }).pywebview?.api?.toggle_fullscreen));
    check();
    window.addEventListener("pywebviewready", check, { once: true });
    return () => window.removeEventListener("pywebviewready", check);
  }, []);
  if (!available) return null;
  return <IconButton label="切换全屏" title="切换全屏" onClick={() => void (window as typeof window & { pywebview?: { api?: DesktopBridge } }).pywebview?.api?.toggle_fullscreen?.()}><Maximize2 /></IconButton>;
}
