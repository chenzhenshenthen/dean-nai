"use client";

import { useEffect, useState } from "react";
import { loadAppPreferences, saveAppPreferences, type AppPreferences } from "@/lib/app-preferences";

export function useAppPreferences() {
  const [preferences, setPreferences] = useState<AppPreferences>(() => loadAppPreferences());
  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<AppPreferences>).detail;
      setPreferences(detail || loadAppPreferences());
    };
    window.addEventListener("dean-nai-preferences-changed", sync);
    return () => window.removeEventListener("dean-nai-preferences-changed", sync);
  }, []);
  const patch = (value: Partial<AppPreferences>) => {
    const next = saveAppPreferences({ ...loadAppPreferences(), ...value });
    setPreferences(next);
  };
  return { preferences, patch };
}
