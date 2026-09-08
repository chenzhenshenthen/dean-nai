export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const libraryBase = () => (process.env.NAI_LIBRARY_URL || "http://127.0.0.1:5179").replace(/\/+$/, "");

export async function GET() {
  try {
    const response = await fetch(`${libraryBase()}/api/navigation`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return Response.json({ error: `资料库返回 HTTP ${response.status}` }, { status: 502 });
    }
    return Response.json(await response.json(), { headers: { "cache-control": "no-store" } });
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
