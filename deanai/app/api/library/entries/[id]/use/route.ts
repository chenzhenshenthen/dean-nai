type RouteContext = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const libraryBase = () => (process.env.NAI_LIBRARY_URL || "http://127.0.0.1:5179").replace(/\/+$/, "");

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "无效资料编号" }, { status: 400 });

  try {
    const response = await fetch(`${libraryBase()}/api/entries/${id}/use`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return Response.json({ error: `资料库返回 HTTP ${response.status}` }, { status: 502 });
    }
    return Response.json(await response.json(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: "无法记录资料使用次数", detail: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
