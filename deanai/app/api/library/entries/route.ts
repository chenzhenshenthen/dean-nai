import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const libraryBase = () => (process.env.NAI_LIBRARY_URL || "http://127.0.0.1:5179").replace(/\/+$/, "");

export async function GET(req: NextRequest) {
  const source = req.nextUrl.searchParams;
  const kind = source.get("kind") === "prompt" ? "prompt" : "artist";
  const query = (source.get("q") || "").trim().slice(0, 200);
  const category = (source.get("category") || "").trim().slice(0, 300);
  const groupId = (source.get("group_id") || "").trim();
  const ratingMin = source.get("rating_min") || "";
  const ratingMax = source.get("rating_max") || "";
  const unratedOnly = source.get("unrated_only") === "1";
  const style = (source.get("style") || "").trim().slice(0, 80);
  const styleUnclassified = source.get("style_unclassified") === "1";
  const limit = Math.min(Math.max(Number(source.get("limit")) || 40, 1), 80);
  const offset = Math.min(Math.max(Number(source.get("offset")) || 0, 0), 1_000_000);
  const requestedSort = source.get("sort") || "";
  const allowedSorts = new Set(["rating_desc", "rating_asc", "usage_desc", "manual", "newest", "created_desc", "title"]);
  const sort = allowedSorts.has(requestedSort) ? requestedSort : kind === "artist" ? "rating_desc" : "usage_desc";

  const params = new URLSearchParams({
    kind,
    q: query,
    search_scope: "directory",
    sort,
    limit: String(limit),
    offset: String(offset),
  });
  if (category) params.set("category_prefix", category);
  if (/^\d+$/.test(groupId)) params.set("group_id", groupId);
  if (kind === "artist" && ["6", "8", "9"].includes(ratingMin)) params.set("rating_min", ratingMin);
  if (kind === "artist" && ["5", "7", "8"].includes(ratingMax)) params.set("rating_max", ratingMax);
  if (kind === "artist" && unratedOnly) params.set("unrated_only", "1");
  if (kind === "artist" && style) params.set("style", style);
  if (kind === "artist" && styleUnclassified) params.set("style_unclassified", "1");

  try {
    const response = await fetch(`${libraryBase()}/api/entries?${params}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return Response.json({ error: `资料库返回 HTTP ${response.status}` }, { status: 502 });
    }
    const data = await response.json();
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        error: "无法连接本地 nai-artist-library，请先启动它（默认端口 5179）。",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
