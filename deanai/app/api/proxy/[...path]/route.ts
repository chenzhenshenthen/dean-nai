import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-side proxy that forwards browser requests to a cross-origin API gateway
 * (e.g. NyaProxy at api.novelai.moe).
 *
 * Why this exists: dean-nai is a pure client-side app, so generation requests normally go
 * straight from the browser to the configured NovelAI host. That works for NovelAI's own
 * endpoints, but third-party gateways (NyaProxy and friends) often sit behind an Nginx that
 * enforces a CORS origin whitelist. Our origin (the dean-nai deployment) is usually not on it,
 * so the browser blocks every request with "Disallowed CORS origin" — before auth even runs.
 *
 * A Node server is not bound by CORS, so routing generation traffic through this route bypasses
 * the browser restriction entirely: browser → dean-nai (same origin, no CORS) → this handler →
 * upstream gateway (server-to-server, no CORS).
 *
 * The real target host travels in the `x-nya-target` header (set by NaiClient). The path after
 * /api/proxy/ is appended verbatim to that target, so a request to
 *   POST /api/proxy/ai/generate-image-stream
 * with `x-nya-target: https://api.novelai.moe/api/novelai` is forwarded to
 *   POST https://api.novelai.moe/api/novelai/ai/generate-image-stream
 *
 * Only the Authorization header and content-type are forwarded; hop-by-hop and browser-only
 * headers (Origin, Referer, Sec-Fetch-*, cookie) are deliberately dropped so the upstream sees a
 * clean server-to-server request. The upstream response is streamed back verbatim so msgpack/SSE
 * chunks reach the browser intact.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const target = req.headers.get("x-nya-target");
  const { path } = await params;

  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-nya-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Local builds do not expose an arbitrary forward proxy. A custom gateway must be explicitly
  // opted in by setting NYANOVEL_PROXY_TARGET to the exact base URL entered in the connection UI.
  // Direct NovelAI requests never pass through this route.
  const allowedTarget = process.env.NYANOVEL_PROXY_TARGET?.replace(/\/+$/, "");
  if (!allowedTarget || target.replace(/\/+$/, "") !== allowedTarget) {
    return new Response(JSON.stringify({ error: "Custom proxy target is not enabled in this local build" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  const base = target.replace(/\/+$/, "");
  const suffix = (path ?? []).join("/");
  const url = `${base}/${suffix}`;

  let body: ArrayBuffer;
  try {
    body = await req.arrayBuffer();
  } catch {
    return new Response(JSON.stringify({ error: "Failed to read request body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const headers = new Headers();
  const auth = req.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  headers.set("content-type", req.headers.get("content-type") ?? "application/json");
  headers.set("accept", req.headers.get("accept") ?? "*/*");

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers,
      body,
      // Long generation streams can run for a while; only time-to-headers matters here, and the
      // stream itself is not bounded by this signal.
      signal: AbortSignal.timeout(300000),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `Proxy upstream failed: ${e instanceof Error ? e.message : String(e)}` }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
