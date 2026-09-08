"use client";

/**
 * Theme application. Extracted from theme-controls so the command palette can drive the same
 * transition — two copies of this would be two chances for the DOM attribute, localStorage key,
 * and the `nya-theme-change` event (which AppToaster listens on) to drift apart.
 *
 * The inline no-flash script in app/layout.tsx reads the same two keys before first paint.
 */

export type Mode = "dark" | "light";

export const ACCENTS = [
  { key: "default", label: "Coral", swatch: "#f35f52" },
  { key: "blue", label: "Blue", swatch: "#4775d1" },
  { key: "magenta", label: "Magenta", swatch: "#d9469d" },
  { key: "violet", label: "Violet", swatch: "#8d43d4" },
  { key: "emerald", label: "Emerald", swatch: "#2f9b75" },
] as const;

export type AccentKey = (typeof ACCENTS)[number]["key"];
export const DEFAULT_CUSTOM_ACCENT = "#f35f52";
export const DEFAULT_ACCENT_SLOTS = ["#f35f52", "#4775d1", "#d9469d", "#8d43d4", "#2f9b75"] as const;
const CUSTOM_ACCENT_KEY = "nya-accent-color";
const ACCENT_SLOTS_KEY = "nya-accent-slots";
const ACTIVE_SLOT_KEY = "nya-accent-active-slot";

export function currentMode(): Mode {
  return (document.documentElement.getAttribute("data-mode") as Mode) || "dark";
}

export function currentAccent(): string {
  return document.documentElement.getAttribute("data-accent") || "default";
}

export function normalizeHexColor(value: string): string | null {
  const input = value.trim();
  const short = /^#?([0-9a-f]{3})$/i.exec(input);
  if (short) return "#" + short[1].split("").map((part) => part + part).join("").toLowerCase();
  const full = /^#?([0-9a-f]{6})$/i.exec(input);
  return full ? "#" + full[1].toLowerCase() : null;
}

export function currentCustomAccent(): string {
  return normalizeHexColor(localStorage.getItem(CUSTOM_ACCENT_KEY) || "") || DEFAULT_CUSTOM_ACCENT;
}

export function currentAccentSlots(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(ACCENT_SLOTS_KEY) || "null");
    if (Array.isArray(value) && value.length === 5) {
      const normalized = value.map((item) => normalizeHexColor(String(item)));
      if (normalized.every(Boolean)) return normalized as string[];
    }
  } catch {
    // Fall back to defaults when old or manually edited storage is invalid.
  }
  return [...DEFAULT_ACCENT_SLOTS];
}

export function currentActiveAccentSlot(): number {
  const value = Number(localStorage.getItem(ACTIVE_SLOT_KEY));
  return Number.isInteger(value) && value >= 0 && value < 5 ? value : 0;
}

function foregroundFor(hex: string): string {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return luminance > 0.46 ? "#171719" : "#ffffff";
}

export function applyMode(next: Mode) {
  document.documentElement.setAttribute("data-mode", next);
  localStorage.setItem("nya-mode", next);
  window.dispatchEvent(new Event("nya-theme-change"));
}

export function applyAccent(next: string) {
  const slot = ACCENTS.findIndex((item) => item.key === next);
  if (slot >= 0) {
    applyAccentSlot(slot, currentAccentSlots());
    return;
  }
  const d = document.documentElement;
  d.style.removeProperty("--accent-custom");
  d.style.removeProperty("--on-accent");
  if (next === "default") {
    d.removeAttribute("data-accent");
    localStorage.removeItem("nya-accent");
  } else {
    d.setAttribute("data-accent", next);
    localStorage.setItem("nya-accent", next);
  }
  window.dispatchEvent(new Event("nya-theme-change"));
}

export function applyCustomAccent(value: string): boolean {
  const color = normalizeHexColor(value);
  if (!color) return false;
  const d = document.documentElement;
  d.setAttribute("data-accent", "custom");
  d.style.setProperty("--accent-custom", color);
  d.style.setProperty("--on-accent", foregroundFor(color));
  localStorage.setItem("nya-accent", "custom");
  localStorage.setItem(CUSTOM_ACCENT_KEY, color);
  window.dispatchEvent(new Event("nya-theme-change"));
  return true;
}

export function applyAccentSlot(index: number, slots: string[], persist = true): boolean {
  const normalized = slots.map((item) => normalizeHexColor(item));
  if (normalized.length !== 5 || normalized.some((item) => !item)) return false;
  const safeIndex = Math.min(Math.max(Math.trunc(index), 0), 4);
  const colors = normalized as string[];
  localStorage.setItem(ACCENT_SLOTS_KEY, JSON.stringify(colors));
  localStorage.setItem(ACTIVE_SLOT_KEY, String(safeIndex));
  applyCustomAccent(colors[safeIndex]);
  if (persist) {
    void fetch("/api/theme-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme_slots: colors, theme_active_slot: safeIndex }),
    }).catch(() => undefined);
  }
  return true;
}

export async function loadPersistedAccentSlots(): Promise<{ slots: string[]; active: number }> {
  const response = await fetch("/api/integrated-settings");
  if (!response.ok) throw new Error("Unable to load theme settings");
  const data = await response.json() as { theme_slots?: unknown; theme_active_slot?: unknown };
  const slots = Array.isArray(data.theme_slots) ? data.theme_slots.map(String) : currentAccentSlots();
  const active = Number(data.theme_active_slot);
  return { slots, active: Number.isInteger(active) ? active : 0 };
}
