"use client";

import { useEffect } from "react";

const MAX_FIELD_LENGTH = 12_000;

function clipped(value: unknown) {
  return String(value ?? "").slice(0, MAX_FIELD_LENGTH);
}

function report(payload: Record<string, unknown>) {
  if (process.env.NEXT_PUBLIC_STATIC_PWA === "1") return;
  void fetch("/api/client-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {
    // Logging must never create another unhandled rejection.
  });
}

/** Persist uncaught browser failures into the dean-nai server log without sending user content. */
export function ClientErrorLogger() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      report({
        kind: "error",
        message: clipped(event.message),
        stack: clipped(event.error instanceof Error ? event.error.stack : ""),
        source: clipped(event.filename),
        line: event.lineno,
        column: event.colno,
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      report({
        kind: "unhandled-rejection",
        message: clipped(reason instanceof Error ? reason.message : reason),
        stack: clipped(reason instanceof Error ? reason.stack : ""),
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
