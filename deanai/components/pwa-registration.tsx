"use client";

import { useEffect } from "react";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function PwaRegistration() {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_LOCAL_DESKTOP === "1") {
      if ("serviceWorker" in navigator) {
        void navigator.serviceWorker.getRegistrations().then((registrations) =>
          Promise.all(registrations.map((registration) => registration.unregister())),
        );
      }
      if ("caches" in window) {
        void caches.keys().then((keys) =>
          Promise.all(keys.filter((key) => key.startsWith("nyanovel-pwa-") || key.startsWith("deanai-pwa-")).map((key) => caches.delete(key))),
        );
      }
      return;
    }
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (value: "portrait-primary") => Promise<void>;
    };
    let reportedLockFailure = false;
    const lockPortrait = () => {
      if (!isStandalone || !orientation.lock) return;
      void orientation.lock("portrait-primary").catch((reason: unknown) => {
        if (reportedLockFailure) return;
        reportedLockFailure = true;
        console.warn(
          "[PWA] Edge/Android rejected the portrait orientation lock. The manifest preference remains active.",
          reason,
        );
      });
    };
    const lockWhenVisible = () => {
      if (document.visibilityState === "visible") lockPortrait();
    };

    lockPortrait();
    window.addEventListener("focus", lockPortrait);
    window.addEventListener("pageshow", lockPortrait);
    window.addEventListener("pointerdown", lockPortrait);
    document.addEventListener("visibilitychange", lockWhenVisible);
    orientation.addEventListener("change", lockPortrait);

    let reloading = false;
    const hadController = "serviceWorker" in navigator && Boolean(navigator.serviceWorker.controller);
    const reloadForUpdatedWorker = () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", reloadForUpdatedWorker);
      const register = async () => {
        try {
          const registration = await navigator.serviceWorker.register(`${BASE_PATH}/sw.js`, {
            scope: `${BASE_PATH}/`,
            updateViaCache: "none",
          });
          await registration.update();
          if (navigator.storage?.persist) void navigator.storage.persist();
        } catch {
          // The normal web app remains usable when a browser disables service workers.
        }
      };
      void register();
    }

    return () => {
      window.removeEventListener("focus", lockPortrait);
      window.removeEventListener("pageshow", lockPortrait);
      window.removeEventListener("pointerdown", lockPortrait);
      document.removeEventListener("visibilitychange", lockWhenVisible);
      orientation.removeEventListener("change", lockPortrait);
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("controllerchange", reloadForUpdatedWorker);
      }
    };
  }, []);
  return null;
}
