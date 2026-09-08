import type { NextRequest } from "next/server";
import { proxyLocalApi } from "@/lib/local-api-proxy";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

async function forward(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const suffix = path.map(encodeURIComponent).join("/");
  return proxyLocalApi(request, "/api/online-gallery/" + suffix + request.nextUrl.search);
}

export function GET(request: NextRequest, context: RouteContext) {
  return forward(request, context);
}
