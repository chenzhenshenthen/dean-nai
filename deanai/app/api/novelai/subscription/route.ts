import { NextRequest } from "next/server";
import { hasNovelAITokenFormat, normalizeNovelAIToken } from "@/lib/nai/token";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null) as { token?: unknown } | null;
  const token = typeof payload?.token === "string" ? normalizeNovelAIToken(payload.token) : "";
  if (!hasNovelAITokenFormat(token)) {
    return Response.json({ error: "Invalid token format" }, { status: 400 });
  }
  try {
    const upstream = await fetch("https://image.novelai.net/user/subscription", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "deanai/2.0.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "NovelAI unavailable" },
      { status: 502 },
    );
  }
}
