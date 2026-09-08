export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const libraryBase = () => (process.env.NAI_LIBRARY_URL || "http://127.0.0.1:5179").replace(/\/+$/, "");

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return new Response("Invalid asset id", { status: 400 });

  try {
    const upstream = await fetch(`${libraryBase()}/asset/${id}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok || !upstream.body) {
      return new Response("Library image unavailable", { status: upstream.status || 502 });
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") || "image/jpeg",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("Local library is not running", { status: 503 });
  }
}
