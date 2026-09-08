"use client";

export function reportClientEvent(kind: string, message: string) {
  if (process.env.NEXT_PUBLIC_STATIC_PWA === "1") return;
  void fetch("/api/client-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: kind.slice(0, 80), message: message.slice(0, 2000) }),
    keepalive: true,
  }).catch(() => undefined);
}
